require('dotenv').config();

const express = require('express');
const basicAuth = require('express-basic-auth');
const path = require('path');

const db = require('./db');
const { scanOnce } = require('./scanner');
const { startBot, sendAlerts } = require('./bot');

const app = express();
app.use(express.json());

// Public static files
app.use(express.static(path.join(__dirname, 'public')));

const adminUser = process.env.ADMIN_USER || 'admin';
const adminPassword = process.env.ADMIN_PASSWORD || 'changeme';

const adminAuth = basicAuth({
  users: {
    [adminUser]: adminPassword
  },
  challenge: true,
  realm: 'feretory-server'
});

let scanning = false;

async function runScanAndAlert() {
  if (scanning) {
    console.log('[scan] already running');
    return;
  }

  scanning = true;

  try {
    const finds = await scanOnce();
    await sendAlerts(finds);
  } catch (err) {
    console.error('[scan] failed:', err);
  } finally {
    scanning = false;
  }
}

// Public Privacy Policy URL
app.get('/privacy', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'privacy.html'));
});

// Public Terms of Service URL
app.get('/terms', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'terms.html'));
});

app.get('/', adminAuth, (req, res) => {
  const finds = db.prepare(`
    SELECT id, plugin_name, title, link, score, status, created_at
    FROM finds
    ORDER BY id DESC
    LIMIT 50
  `).all();

  res.send(`
    <html>
      <head>
        <title>feretory-server</title>
        <style>
          body { font-family: Arial; background:#111; color:#eee; padding:20px; }
          a { color:#8dbbff; }
          .card { border:1px solid #333; padding:12px; margin:10px 0; border-radius:10px; background:#1b1b1b; }
          .score { font-weight:bold; color:#7dffb2; }
          .nav { margin-bottom:20px; }
        </style>
      </head>
      <body>
        <h1>feretory-server</h1>
        <div class="nav">
          <a href="/scan">Run scan now</a> |
          <a href="/training">Training</a> |
          <a href="/api/finds">API Finds</a> |
          <a href="/health">Health</a> |
          <a href="/privacy">Privacy</a> |
          <a href="/terms">Terms</a>
        </div>

        ${finds.length ? finds.map(f => `
          <div class="card">
            <div class="score">Score: ${f.score} | ${escapeHtml(f.status)}</div>
            <h3>${escapeHtml(f.title)}</h3>
            <p>${escapeHtml(f.plugin_name)} | ${escapeHtml(f.created_at)}</p>
            ${f.link ? `<a href="${escapeAttr(f.link)}" target="_blank">${escapeHtml(f.link)}</a>` : ''}
          </div>
        `).join('') : '<p>No finds yet.</p>'}
      </body>
    </html>
  `);
});

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/scan', adminAuth, async (req, res) => {
  await runScanAndAlert();
  res.redirect('/');
});

app.get('/api/finds', adminAuth, (req, res) => {
  const finds = db.prepare(`
    SELECT *
    FROM finds
    ORDER BY id DESC
    LIMIT 100
  `).all();

  res.json(finds);
});

app.get('/training', adminAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT *
    FROM training_terms
    ORDER BY ABS(learned_weight) DESC, term ASC
  `).all();

  res.send(`
    <html>
      <head>
        <title>feretory training</title>
        <style>
          body { font-family: Arial; background:#111; color:#eee; padding:20px; }
          table { border-collapse: collapse; width: 100%; }
          td, th { border:1px solid #333; padding:8px; }
          a { color:#8dbbff; }
          .nav { margin-bottom:20px; }
        </style>
      </head>
      <body>
        <h1>Training Terms</h1>
        <div class="nav">
          <a href="/">Back</a> |
          <a href="/scan">Run scan now</a> |
          <a href="/privacy">Privacy</a> |
          <a href="/terms">Terms</a>
        </div>

        ${rows.length ? `
          <table>
            <tr>
              <th>Term</th>
              <th>Legit</th>
              <th>False</th>
              <th>Learned Weight</th>
              <th>Updated</th>
            </tr>
            ${rows.map(r => `
              <tr>
                <td>${escapeHtml(r.term)}</td>
                <td>${r.legit_count}</td>
                <td>${r.false_count}</td>
                <td>${r.learned_weight}</td>
                <td>${escapeHtml(r.updated_at)}</td>
              </tr>
            `).join('')}
          </table>
        ` : '<p>No training data yet.</p>'}
      </body>
    </html>
  `);
});

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function escapeAttr(value) {
  return escapeHtml(value);
}

async function main() {
  await startBot();

  const port = Number(process.env.PORT || 3000);

  app.listen(port, '0.0.0.0', () => {
    console.log(`[server] listening on port ${port}`);
  });

  const interval = Math.max(1, Number(process.env.SCAN_INTERVAL_MINUTES || 10));

  setInterval(runScanAndAlert, interval * 60 * 1000);

  await runScanAndAlert();
}

main();
