// Enhanced logging utility
class Logger {
  constructor(name = 'AVA') {
    this.name = name;
    this.levels = {
      error: 0,
      warn: 1,
      info: 2,
      debug: 3
    };
    this.currentLevel = process.env.LOG_LEVEL || 'info';
  }

  _shouldLog(level) {
    return this.levels[level] <= this.levels[this.currentLevel];
  }

  _formatMessage(level, message, meta = {}) {
    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [${this.name}] [${level.toUpperCase()}]`;
    
    if (typeof message === 'object') {
      return `${prefix} ${JSON.stringify(message, null, 2)}`;
    }
    
    const metaStr = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
    return `${prefix} ${message}${metaStr}`;
  }

  error(message, meta = {}) {
    if (this._shouldLog('error')) {
      console.error(this._formatMessage('error', message, meta));
    }
  }

  warn(message, meta = {}) {
    if (this._shouldLog('warn')) {
      console.warn(this._formatMessage('warn', message, meta));
    }
  }

  info(message, meta = {}) {
    if (this._shouldLog('info')) {
      console.info(this._formatMessage('info', message, meta));
    }
  }

  debug(message, meta = {}) {
    if (this._shouldLog('debug')) {
      console.debug(this._formatMessage('debug', message, meta));
    }
  }
}

export function createLogger(name) {
  return new Logger(name);
}

export default new Logger('AVA');