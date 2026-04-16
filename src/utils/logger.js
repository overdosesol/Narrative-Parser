import fs from 'fs';
import path from 'path';

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

class Logger {
  constructor(level = 'info') {
    this.level = LOG_LEVELS[level] ?? LOG_LEVELS.info;
    // Use LOG_FILE env var directory, or /logs absolute, never relative ./logs
    const logFile = process.env.LOG_FILE;
    this.logDir = logFile ? path.dirname(logFile) : '/logs';
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }

  _format(level, message, data) {
    const timestamp = new Date().toISOString();
    const dataStr = data ? ` | ${JSON.stringify(data)}` : '';
    return `[${timestamp}] [${level.toUpperCase()}] ${message}${dataStr}`;
  }

  _write(level, message, data) {
    if (LOG_LEVELS[level] < this.level) return;

    const formatted = this._format(level, message, data);

    // Console with colors
    const colors = { debug: '\x1b[36m', info: '\x1b[32m', warn: '\x1b[33m', error: '\x1b[31m' };
    const reset = '\x1b[0m';
    console.log(`${colors[level] || ''}${formatted}${reset}`);

    // File
    const date = new Date().toISOString().split('T')[0];
    const logFile = path.join(this.logDir, `${date}.log`);
    fs.appendFileSync(logFile, formatted + '\n');
  }

  debug(msg, data) { this._write('debug', msg, data); }
  info(msg, data) { this._write('info', msg, data); }
  warn(msg, data) { this._write('warn', msg, data); }
  error(msg, data) { this._write('error', msg, data); }
}

export default Logger;
