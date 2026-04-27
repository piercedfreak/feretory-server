const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');

function sha1(value) {
  return crypto.createHash('sha1').update(String(value)).digest('hex');
}

function safeJsonParse(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function deepGet(obj, pathString) {
  if (!pathString || pathString === '$') return obj;

  const parts = String(pathString)
    .replace(/^\$\./, '')
    .replace(/^\$/, '')
    .split('.')
    .filter(Boolean);

  let current = obj;

  for (const part of parts) {
    if (current == null) return undefined;
    current = current[part];
  }

  return current;
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  return [value];
}

function applyTemplate(template, item) {
  return String(template || '').replace(/\{([^}]+)\}/g, (_, key) => {
    const value = deepGet(item, key.trim());
    return value == null ? '' : String(value);
  });
}

function addQueryParam(url, key, value) {
  const parsed = new URL(url);
  parsed.searchParams.set(key, value);
  return parsed.toString();
}

function loadPlugins() {
  const dir = process.env.PLUGINS_DIR || './plugins';
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  return fs.readdirSync(dir)
    .filter(file => file.endsWith('.json'))
    .map(file => {
      const fullPath = path.join(dir, file);
      const raw = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
      return {
        ...raw,
        fileName: file,
        maxPages: Math.max(1, Number(raw.maxPages || 1)),
        paginationType: raw.paginationType || 'none'
      };
    })
    .filter(plugin => plugin.enabled !== false);
}

async function fetchUrl(url, plugin) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(plugin.timeoutMs || 20000));

  try {
    const res = await fetch(url, {
      headers: plugin.headers || {},
      signal: controller.signal
    });

    const text = await res.text();

    return {
      ok: res.ok,
      status: res.status,
      url,
      text
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchPages(plugin) {
  const pages = [];
  let nextUrl = plugin.url;
  let afterToken = '';

  for (let page = 1; page <= plugin.maxPages; page++) {
    if (plugin.paginationType === 'page-param') {
      nextUrl = addQueryParam(plugin.url, 'page', String(page));
    }

    if (plugin.paginationType === 'reddit-after' && page > 1) {
      if (!afterToken) break;
      nextUrl = addQueryParam(plugin.url, 'after', afterToken);
    }

    const response = await fetchUrl(nextUrl, plugin);
    pages.push(response);

    if (plugin.paginationType === 'reddit-after') {
      const parsed = safeJsonParse(response.text);
      afterToken = parsed?.data?.after || '';
      if (!afterToken) break;
    }

    if (plugin.paginationType === 'none') break;
  }

  return pages;
}

function extractJsonItems(parsed, plugin) {
  const rawItems = asArray(deepGet(parsed, plugin.itemPath));
  return rawItems.map(raw => {
    const title = normalizeText(deepGet(raw, plugin.fields.title));
    const body = normalizeText(deepGet(raw, plugin.fields.body));
    const id = normalizeText(deepGet(raw, plugin.fields.id));
    const rawLink = plugin.linkTemplate
      ? applyTemplate(plugin.linkTemplate, raw)
      : deepGet(raw, plugin.fields.link);

    return {
      itemId: id,
      title,
      body,
      link: String(rawLink || ''),
      raw
    };
  });
}

function scoreBlock(text, terms, multiplier) {
  let score = 0;
  const matched = [];
  const haystack = String(text || '').toLowerCase();

  for (const [term, weight] of Object.entries(terms || {})) {
    const needle = String(term).toLowerCase().trim();
    if (!needle) continue;

    if (haystack.includes(needle)) {
      const points = Number(weight) * multiplier;
      score += points;
      matched.push({ term, score: points });
    }
  }

  return { score, matched };
}

function getLearnedAdjustment(item) {
  const rows = db.prepare('SELECT term, learned_weight FROM training_terms').all();

  let learnedScore = 0;
  const learnedMatches = [];
  const haystack = `${item.title} ${item.body}`.toLowerCase();

  for (const row of rows) {
    if (haystack.includes(row.term.toLowerCase())) {
      learnedScore += row.learned_weight;
      learnedMatches.push({
        term: row.term,
        score: row.learned_weight
      });
    }
  }

  return { learnedScore, learnedMatches };
}

function scoreItem(plugin, item) {
  const scoreCfg = plugin.score || {};
  const terms = scoreCfg.terms || {};
  const penalties = scoreCfg.penalties || {};
  const titleMultiplier = Number(scoreCfg.titleMultiplier || 2);
  const bodyMultiplier = Number(scoreCfg.bodyMultiplier || 1);

  const titleHit = scoreBlock(item.title, terms, titleMultiplier);
  const bodyHit = scoreBlock(item.body, terms, bodyMultiplier);
  const titlePenalty = scoreBlock(item.title, penalties, titleMultiplier);
  const bodyPenalty = scoreBlock(item.body, penalties, bodyMultiplier);
  const learned = getLearnedAdjustment(item);

  const baseScore =
    titleHit.score +
    bodyHit.score +
    titlePenalty.score +
    bodyPenalty.score;

  const finalScore = baseScore + learned.learnedScore;

  return {
    ...item,
    pluginId: plugin.id,
    pluginName: plugin.name,
    baseScore,
    learnedScore: learned.learnedScore,
    score: finalScore,
    matchedPositive: [...titleHit.matched, ...bodyHit.matched],
    matchedNegative: [...titlePenalty.matched, ...bodyPenalty.matched],
    matchedLearned: learned.learnedMatches,
    passed: finalScore >= Number(scoreCfg.minimumScore || 8)
  };
}

function dedupeKey(plugin, item) {
  return sha1(`${plugin.id}|${item.itemId || item.title}|${item.link}`);
}

function saveFind(item) {
  const key = dedupeKey({ id: item.pluginId }, item);

  const existing = db.prepare('SELECT id FROM finds WHERE dedupe_key = ?').get(key);
  if (existing) return null;

  const result = db.prepare(`
    INSERT INTO finds (
      plugin_id, plugin_name, item_id, title, body, link, score,
      matched_positive, matched_negative, dedupe_key, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    item.pluginId,
    item.pluginName,
    item.itemId || '',
    item.title,
    item.body,
    item.link,
    item.score,
    JSON.stringify(item.matchedPositive || []),
    JSON.stringify(item.matchedNegative || []),
    key,
    new Date().toISOString()
  );

  return {
    ...item,
    id: result.lastInsertRowid,
    dedupeKey: key
  };
}

async function scanOnce() {
  const plugins = loadPlugins();
  const freshFinds = [];

  for (const plugin of plugins) {
    console.log(`[scan] ${plugin.name}`);

    const pages = await fetchPages(plugin);
    let extracted = [];

    for (const page of pages) {
      if (plugin.type === 'json-feed') {
        const parsed = safeJsonParse(page.text);
        if (!parsed) continue;
        extracted.push(...extractJsonItems(parsed, plugin));
      }
    }

    const scored = extracted
      .map(item => scoreItem(plugin, item))
      .filter(item => item.passed)
      .sort((a, b) => b.score - a.score);

    for (const item of scored) {
      const saved = saveFind(item);
      if (saved) freshFinds.push(saved);
    }
  }

  freshFinds.sort((a, b) => b.score - a.score);

  console.log(`[scan] fresh finds: ${freshFinds.length}`);
  return freshFinds;
}

module.exports = {
  scanOnce
};
