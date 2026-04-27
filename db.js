const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

const dbPath = process.env.DATABASE_PATH || './data/feretory.db';
ensureDir(dbPath);

const db = new Database(dbPath);

db.exec(`
CREATE TABLE IF NOT EXISTS finds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plugin_id TEXT NOT NULL,
  plugin_name TEXT NOT NULL,
  item_id TEXT,
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,
  score INTEGER NOT NULL,
  matched_positive TEXT,
  matched_negative TEXT,
  dedupe_key TEXT UNIQUE NOT NULL,
  discord_message_id TEXT,
  status TEXT DEFAULT 'new',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS votes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  find_id INTEGER NOT NULL,
  discord_user_id TEXT,
  discord_username TEXT,
  vote TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(find_id, discord_user_id),
  FOREIGN KEY(find_id) REFERENCES finds(id)
);

CREATE TABLE IF NOT EXISTS training_terms (
  term TEXT PRIMARY KEY,
  legit_count INTEGER DEFAULT 0,
  false_count INTEGER DEFAULT 0,
  learned_weight INTEGER DEFAULT 0,
  updated_at TEXT NOT NULL
);
`);

module.exports = db;
