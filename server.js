require('dotenv').config();

const express = require('express');
const basicAuth = require('express-basic-auth');
const path = require('path');
const fs = require('fs');

const db = require('./db');
const logger = require('./logger');
const { scanOnce } = require('./scanner');
const { startBot, sendAlerts } = require('./bot');
const pkg = require('./package.json');

const app = express();

app.set('json spaces', 2);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const adminUser = process.env.ADMIN_USER || 'admin';
const adminPassword = process.env.ADMIN_PASSWORD || 'changeme';

const adminAuth = basicAuth({
  users: { [adminUser]: adminPassword },
  challenge: true,
  realm: 'feretory-server'
});

let scanning = false;
let lastScanAt = null;
let lastScanResult = null;

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function layout(title, content) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)} | feretory-server</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { margin: 0; font-family: Arial, sans-serif; background: #111827; color: #e5e7eb; }
    header { background: #020617; padding: 18px 24px; border-bottom: 1px solid #334155; }
    header h1 { margin: 0; font-size: 24px; }
    header small { color: #94a3b8; }
    nav { margin-top: 14px; display: flex; flex-wrap: wrap; gap: 10px; }
    nav a, .button {
      color: #fff; background: #2563eb; text-decoration: none;
      padding: 9px 13px; border-radius: 8px; border: 0;
      cursor: pointer; font-size: 14px;
    }
    nav a.secondary, .button.secondary { background: #374151; }
    main { padding: 24px; max-width: 1200px; margin: 0 auto; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 16px; margin-bottom: 22px; }
    .card {
      background: #1f2937; border: 1px solid #374151;
      border-radius: 14px; padding: 16px;
      box-shadow: 0 10px 20px rgba(0,0,0,.2);
      margin-bottom: 18px;
    }
    .metric { font-size: 30px; font-weight: bold; margin-top: 8px; }
    .muted { color: #9ca3af; }
    table { width: 100%; border-collapse: collapse; background: #1f2937; border-radius: 14px; overflow: hidden; }
    th, td { text-align: left; padding: 11px; border-bottom: 1px solid #374151; vertical-align: top; }
    th { background: #0f172a; color: #cbd5e1; }
    tr:hover { background: #263244; }
    a { color: #93c5fd; }
    .pill { display: inline-block; padding: 4px 8px; border-radius: 999px; background: #334155; font-size: 12px; }
    .pill.new { background: #2563eb; }
    .pill.legit { background: #16a34a; }
    .pill.false_positive { background: #dc2626; }
    pre {
      background: #020617; border: 1px solid #334155;
      padding: 14px; border-radius: 12px; overflow: auto;
      max-height: 650px; white-space: pre-wrap;
    }
  </style>
</head>
<body>
  <header>
    <h1>feretory-server</h1>
    <small>Version ${escapeHtml(pkg.version)}</small>
    <nav>
      <a href="/">Dashboard</a>
      <a href="/scan">Run Scan</a>
      <a href="/training">Training</a>
      <a href="/logs">Logs</a>
      <a href="/health" class="secondary">Health</a>
      <a href="/api/finds" class="secondary">API Finds</a>
      <a href="/privacy" class="secondary">Privacy</a>
      <a href="/terms" class="secondary">Terms</a>
    </nav>
  </header>
  <main>${content}</main>
</body>
</html>`;
}

async function runScanAndAlert() {
  if (scanning) {
    logger.warn('Scan skipped because another scan is already running');
    return;
  }

  scanning = true;
  lastScanAt = new Date().toISOString();

  try {
    logger.info('Scan started');

    const finds = await scanOnce();
    await sendAlerts(finds);

    lastScanResult = {
      ok: true,
      freshFinds: finds.length,
      completedAt: new Date().toISOString()
    };

    logger.info('Scan completed', lastScanResult);
  } catch (err) {
    lastScanResult = {
      ok: false,
      error: err.message,
      completedAt: new Date().toISOString()
    };

    logger.error('Scan failed', {
      error: err.message,
      stack: err.stack
    });
  } finally {
    scanning = false;
  }
}

app.get('/privacy', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'privacy.html'));
});

app.get('/terms', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'terms.html'));
});

app.get('/', adminAuth, (req, res) => {
  const stats = {
    total: db.prepare('SELECT COUNT(*) AS count FROM finds').get().count,
    fresh: db.prepare("SELECT COUNT(*) AS count FROM finds WHERE status = 'new'").get().count,
    legit: db.prepare("SELECT COUNT(*) AS count FROM finds WHERE status = 'legit'").get().count,
    falsePositive: db.prepare("SELECT COUNT(*) AS count FROM finds WHERE status = 'false_positive'").get().count,
    trainingTerms: db.prepare('SELECT COUNT(*) AS count FROM training_terms').get().count
  };

  const finds = db.prepare(`
    SELECT id, plugin_name, title, link, score, status, created_at
    FROM finds
    ORDER BY id DESC
    LIMIT 50
  `).all();

  res.send(layout('Dashboard', `
    <div class="grid">
      <div class="card"><div class="muted">Total Finds</div><div class="metric">${stats.total}</div></div>
      <div class="card"><div class="muted">New</div><div class="metric">${stats.fresh}</div></div>
      <div class="card"><div class="muted">Legit</div><div class="metric">${stats.legit}</div></div>
      <div class="card"><div class="muted">False Positives</div><div class="metric">${stats.falsePositive}</div></div>
      <div class="card"><div class="muted">Training Terms</div><div class="metric">${stats.trainingTerms}</div></div>
    </div>

    <div class="card">
      <h2>Scanner Status</h2>
      <p><strong>Currently scanning:</strong> ${scanning ? 'Yes' : 'No'}</p>
      <p><strong>Last scan started:</strong> ${escapeHtml(lastScanAt || 'Never')}</p>
      <p><strong>Last result:</strong></p>
      <pre>${escapeHtml(JSON.stringify(lastScanResult || {}, null, 2))}</pre>
    </div>

    <h2>Recent Finds</h2>
    <table>
      <thead>
        <tr>
          <th>ID</th>
          <th>Score</th>
          <th>Status</th>
          <th>Title</th>
          <th>Plugin</th>
          <th>Created</th>
        </tr>
      </thead>
      <tbody>
        ${finds.length ? finds.map(f => `
          <tr>
            <td>${f.id}</td>
            <td>${f.score}</td>
            <td><span class="pill ${escapeHtml(f.status)}">${escapeHtml(f.status)}</span></td>
            <td>${f.link ? `<a href="${escapeHtml(f.link)}" target="_blank">${escapeHtml(f.title)}</a>` : escapeHtml(f.title)}</td>
            <td>${escapeHtml(f.plugin_name)}</td>
            <td>${escapeHtml(f.created_at)}</td>
          </tr>
        `).join('') : '<tr><td colspan="6">No finds yet.</td></tr>'}
      </tbody>
    </table>
  `));
});

app.get('/health', adminAuth, (req, res) => {
  res.send(layout('Health', `
    <div class="card">
      <h2>System Health</h2>
      <pre>${escapeHtml(JSON.stringify({
        ok: true,
        version: pkg.version,
        scanning,
        lastScanAt,
        lastScanResult
      }, null, 2))}</pre>
    </div>
  `));
});

app.get('/health.json', (req, res) => {
  res.json({
    ok: true,
    version: pkg.version,
    scanning,
    lastScanAt,
    lastScanResult
  });
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

  res.type('json').send(JSON.stringify(finds, null, 2));
});

app.get('/training', adminAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT *
    FROM training_terms
    ORDER BY ABS(learned_weight) DESC, term ASC
  `).all();

  res.send(layout('Training', `
    <h2>Training Terms</h2>
    <table>
      <thead>
        <tr>
          <th>Term</th>
          <th>Legit</th>
          <th>False</th>
          <th>Weight</th>
          <th>Updated</th>
        </tr>
      </thead>
      <tbody>
        ${rows.length ? rows.map(r => `
          <tr>
            <td>${escapeHtml(r.term)}</td>
            <td>${r.legit_count}</td>
            <td>${r.false_count}</td>
            <td>${r.learned_weight}</td>
            <td>${escapeHtml(r.updated_at)}</td>
          </tr>
        `).join('') : '<tr><td colspan="5">No training data yet.</td></tr>'}
      </tbody>
    </table>
  `));
});

app.get('/logs', adminAuth, (req, res) => {
  let logText = 'No logs yet.';

  if (fs.existsSync(logger.logFile)) {
    logText = fs.readFileSync(logger.logFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .slice(-200)
      .join('\n');
  }

  res.send(layout('Logs', `
    <h2>Recent Logs</h2>
    <p class="muted">Showing latest 200 log lines.</p>
    <pre>${escapeHtml(logText)}</pre>
  `));
});

async function main() {
  await startBot();

  const port = Number(process.env.PORT || 3000);

  app.listen(port, '0.0.0.0', () => {
    logger.info('Server listening', { port, version: pkg.version });
  });

  const interval = Math.max(1, Number(process.env.SCAN_INTERVAL_MINUTES || 10));
  logger.info('Scan interval configured', { intervalMinutes: interval });

  setInterval(runScanAndAlert, interval * 60 * 1000);

  await runScanAndAlert();
}

main();
