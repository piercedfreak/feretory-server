require('dotenv').config();

const fs = require('fs');
const path = require('path');
const Parser = require('rss-parser');
const db = require('./db');

const PLUGINS_DIR = path.join(__dirname, 'plugins');

function getByPath(obj, pathString) {
  if (!pathString) return undefined;

  return pathString.split('.').reduce((current, key) => {
    if (current === undefined || current === null) return undefined;
    return current[key];
  }, obj);
}

function loadPlugins() {
  if (!fs.existsSync(PLUGINS_DIR)) {
    fs.mkdirSync(PLUGINS_DIR, { recursive: true });
  }

  return fs
    .readdirSync(PLUGINS_DIR)
    .filter(file => file.endsWith('.json'))
    .map(file => {
      const fullPath = path.join(PLUGINS_DIR, file);
      const raw = fs.readFileSync(fullPath, 'utf8');
      return JSON.parse(raw);
    })
    .filter(plugin => plugin.enabled !== false);
}

function normalizeText(value) {
  return String(value || '').toLowerCase();
}

function scoreItem(plugin, item) {
  const scoreConfig = plugin.score || {};
  const terms = scoreConfig.terms || {};
  const requiredAny = scoreConfig.requiredAny || [];
  const blacklist = scoreConfig.blacklist || [];

  const title = normalizeText(item.title);
  const body = normalizeText(item.body);
  const combined = `${title} ${body}`;

  for (const bad of blacklist) {
    if (combined.includes(normalizeText(bad))) {
      return {
        score: 0,
        matchedTerms: [],
        blacklisted: true,
        reason: bad
      };
    }
  }

  if (requiredAny.length > 0) {
    const hasRequired = requiredAny.some(term =>
      combined.includes(normalizeText(term))
    );

    if (!hasRequired) {
      return {
        score: 0,
        matchedTerms: [],
        blacklisted: false,
        reason: 'missing requiredAny'
      };
    }
  }

  let total = 0;
  const matchedTerms = [];

  const titleMultiplier = scoreConfig.titleMultiplier || 1.4;
  const bodyMultiplier = scoreConfig.bodyMultiplier || 1.0;

  for (const [term, points] of Object.entries(terms)) {
    const needle = normalizeText(term);

    if (title.includes(needle)) {
      total += points * titleMultiplier;
      matchedTerms.push(term);
    } else if (body.includes(needle)) {
      total += points * bodyMultiplier;
      matchedTerms.push(term);
    }
  }

  return {
    score: Math.round(total),
    matchedTerms,
    blacklisted: false,
    reason: null
  };
}

function mapJsonItem(plugin, rawItem) {
  const fields = plugin.fields || {};

  return {
    id: getByPath(rawItem, fields.id) || getByPath(rawItem, 'data.id'),
    title: getByPath(rawItem, fields.title) || '',
    body: getByPath(rawItem, fields.body) || '',
    link: getByPath(rawItem, fields.link) || '',
    author: getByPath(rawItem, fields.author) || '',
    created: getByPath(rawItem, fields.created) || '',
    raw: rawItem
  };
}

function mapRssItem(item) {
  return {
    id: item.id || item.guid || item.link,
    title: item.title || '',
    body: item.contentSnippet || item.content || item.summary || '',
    link: item.link || '',
    author: item.creator || item.author || '',
    created: item.isoDate || item.pubDate || '',
    raw: item
  };
}

function applyLinkTemplate(plugin, item) {
  if (!plugin.linkTemplate || !item.link) return item;

  if (item.link.startsWith('http')) return item;

  const data = item.raw && item.raw.data ? item.raw.data : item.raw || {};

  item.link = plugin.linkTemplate.replace(/\{data\.([^}]+)\}/g, (_, key) => {
    return data[key] || '';
  });

  return item;
}

async function fetchJsonFeed(plugin) {
  const headers = plugin.headers || {};

  console.log(`[plugin:${plugin.name}] fetching JSON ${plugin.url}`);

  const response = await fetch(plugin.url, {
    method: plugin.method || 'GET',
    headers
  });

  console.log(
    `[plugin:${plugin.name}] fetch status: ${response.status} ok=${response.ok} url=${plugin.url}`
  );

  const text = await response.text();

  if (!response.ok) {
    console.log(
      `[plugin:${plugin.name}] response preview: ${text.slice(0, 300)}`
    );
    return [];
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch (err) {
    console.error(`[plugin:${plugin.name}] JSON parse failed:`, err.message);
    console.log(
      `[plugin:${plugin.name}] response preview: ${text.slice(0, 300)}`
    );
    return [];
  }

  const items = getByPath(json, plugin.itemPath) || [];

  return items.map(rawItem =>
    applyLinkTemplate(plugin, mapJsonItem(plugin, rawItem))
  );
}

async function fetchRssFeed(plugin) {
  console.log(`[plugin:${plugin.name}] fetching RSS ${plugin.url}`);

  const parser = new Parser({
    headers: plugin.headers || {
      'User-Agent':
        process.env.REDDIT_USER_AGENT ||
        'Mozilla/5.0 linux:feretory:v1.0.0 by /u/freak',
      Accept: 'application/rss+xml, application/xml, text/xml'
    }
  });

  try {
    const feed = await parser.parseURL(plugin.url);

    console.log(
      `[plugin:${plugin.name}] RSS items: ${feed.items ? feed.items.length : 0}`
    );

    return (feed.items || []).map(mapRssItem);
  } catch (err) {
    console.error(`[plugin:${plugin.name}] RSS fetch failed:`, err.message);
    return [];
  }
}

async function alreadySeen(plugin, item) {
  const dedupeKey = `${plugin.id}:${item.id || item.link}`;

  const row = db
    .prepare(`SELECT id FROM finds WHERE dedupe_key = ? LIMIT 1`)
    .get(dedupeKey);

  return !!row;
}

async function markSeen(plugin, item) {
  return;
}

async function scanPlugin(plugin) {
  console.log(`[scan] ${plugin.name}`);

  let items = [];

  if (plugin.type === 'rss-feed') {
    items = await fetchRssFeed(plugin);
  } else if (plugin.type === 'json-feed') {
    items = await fetchJsonFeed(plugin);
  } else {
    console.log(`[plugin:${plugin.name}] unsupported type: ${plugin.type}`);
    return [];
  }

  const finds = [];
  const minimumScore = plugin.score?.minimumScore || 1;

  for (const item of items) {
    const id = item.id || item.link;

    if (!id) continue;

    const seen = await alreadySeen(plugin, item);
    if (seen) continue;

    const scored = scoreItem(plugin, item);

    await markSeen(plugin, item);

    if (scored.score >= minimumScore && !scored.blacklisted) {
      const dedupeKey = `${plugin.id}:${id}`;

      try {
        db.prepare(`
          INSERT INTO finds (
            plugin_id,
            plugin_name,
            item_id,
            title,
            body,
            link,
            score,
            matched_positive,
            matched_negative,
            dedupe_key,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          plugin.id,
          plugin.name,
          id,
          item.title || '',
          item.body || '',
          item.link || '',
          scored.score,
          JSON.stringify(scored.matchedTerms || []),
          JSON.stringify([]),
          dedupeKey,
          new Date().toISOString()
        );
      } catch (err) {
        if (!String(err.message).includes('UNIQUE')) {
          console.error(
            `[plugin:${plugin.name}] DB insert failed:`,
            err.message
          );
        }
        continue;
      }

      finds.push({
        pluginId: plugin.id,
        pluginName: plugin.name,
        source: plugin.name,
        id,
        title: item.title,
        body: item.body,
        link: item.link,
        author: item.author,
        created: item.created,
        score: scored.score,
        matchedTerms: scored.matchedTerms
      });
    }
  }

  console.log(`[plugin:${plugin.name}] matches: ${finds.length}`);

  return finds;
}

async function scanOnce() {
  const plugins = loadPlugins();
  const allFinds = [];

  for (const plugin of plugins) {
    try {
      const finds = await scanPlugin(plugin);
      allFinds.push(...finds);
    } catch (err) {
      console.error(`[plugin:${plugin.name}] scan failed:`, err);
    }
  }

  return allFinds;
}

module.exports = {
  scanOnce,
  loadPlugins,
  scoreItem
};
