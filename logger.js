const fs = require('fs');
const path = require('path');

const logDir = process.env.LOG_DIR || './logs';
const logFile = path.join(logDir, 'feretory.log');

if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

function write(level, message, meta = {}) {
  const line = JSON.stringify({
    time: new Date().toISOString(),
    level,
    message,
    ...meta
  });

  console.log(`[${level}] ${message}`, meta);
  fs.appendFileSync(logFile, line + '\n');
}

module.exports = {
  info: (message, meta) => write('info', message, meta),
  warn: (message, meta) => write('warn', message, meta),
  error: (message, meta) => write('error', message, meta),
  logFile
};
