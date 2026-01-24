/**
 * Structured logging utility for the TurboFetch MCP server.
 *
 * Outputs JSON-formatted logs to stderr (MCP uses stdout for protocol).
 * Respects LOG_LEVEL environment variable (default: info).
 */

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const LOG_LEVELS: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

/** Fields that can appear in log entries */
export interface LogFields {
  event?: string;
  request_id?: string;
  url?: string;
  domain?: string;
  duration_ms?: number;
  status?: number;
  content_length?: number;
  format?: string;
  pool_size?: number;
  pool_available?: number;
  error_code?: string;
  retry_count?: number;
  queue_length?: number;
  [key: string]: string | number | boolean | undefined;
}

interface LogEntry extends LogFields {
  timestamp: string;
  level: LogLevel;
}

/**
 * Determines the current log level from environment.
 * Defaults to 'info' if not set or invalid.
 */
function getLogLevel(): LogLevel {
  const envLevel = process.env.LOG_LEVEL?.toLowerCase();
  if (envLevel && envLevel in LOG_LEVELS) {
    return envLevel as LogLevel;
  }
  return 'info';
}

/**
 * Logger class that outputs structured JSON logs to stderr.
 */
class Logger {
  private minLevel: LogLevel;

  constructor() {
    this.minLevel = getLogLevel();
  }

  /**
   * Reload log level from environment. Useful for runtime config changes.
   */
  reloadLevel(): void {
    this.minLevel = getLogLevel();
  }

  /**
   * Get current minimum log level.
   */
  getLevel(): LogLevel {
    return this.minLevel;
  }

  /**
   * Check if a given level should be logged.
   */
  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] <= LOG_LEVELS[this.minLevel];
  }

  /**
   * Write a log entry to stderr.
   */
  private write(level: LogLevel, fields: LogFields): void {
    if (!this.shouldLog(level)) {
      return;
    }

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      ...fields,
    };

    // Remove undefined values for cleaner output
    const cleanEntry = Object.fromEntries(
      Object.entries(entry).filter(([_, v]) => v !== undefined)
    );

    // Write to stderr so it doesn't interfere with MCP protocol on stdout
    process.stderr.write(JSON.stringify(cleanEntry) + '\n');
  }

  /**
   * Log an error message.
   * Use for: Request failures after retries, unrecoverable errors.
   */
  error(fields: LogFields): void;
  error(event: string, fields?: LogFields): void;
  error(eventOrFields: string | LogFields, maybeFields?: LogFields): void {
    if (typeof eventOrFields === 'string') {
      this.write('error', { event: eventOrFields, ...maybeFields });
    } else {
      this.write('error', eventOrFields);
    }
  }

  /**
   * Log a warning message.
   * Use for: Rate limit hits, request queued, recoverable issues.
   */
  warn(fields: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  warn(eventOrFields: string | LogFields, maybeFields?: LogFields): void {
    if (typeof eventOrFields === 'string') {
      this.write('warn', { event: eventOrFields, ...maybeFields });
    } else {
      this.write('warn', eventOrFields);
    }
  }

  /**
   * Log an info message.
   * Use for: Request completed successfully, server started.
   */
  info(fields: LogFields): void;
  info(event: string, fields?: LogFields): void;
  info(eventOrFields: string | LogFields, maybeFields?: LogFields): void {
    if (typeof eventOrFields === 'string') {
      this.write('info', { event: eventOrFields, ...maybeFields });
    } else {
      this.write('info', eventOrFields);
    }
  }

  /**
   * Log a debug message.
   * Use for: Pool acquire/release, page events, detailed tracing.
   */
  debug(fields: LogFields): void;
  debug(event: string, fields?: LogFields): void;
  debug(eventOrFields: string | LogFields, maybeFields?: LogFields): void {
    if (typeof eventOrFields === 'string') {
      this.write('debug', { event: eventOrFields, ...maybeFields });
    } else {
      this.write('debug', eventOrFields);
    }
  }

  /**
   * Create a child logger with preset fields.
   * Useful for request-scoped logging with a consistent request_id.
   */
  child(baseFields: LogFields): ChildLogger {
    return new ChildLogger(this, baseFields);
  }
}

/**
 * Child logger that includes base fields in all log entries.
 */
class ChildLogger {
  constructor(
    private parent: Logger,
    private baseFields: LogFields
  ) {}

  error(fields: LogFields): void;
  error(event: string, fields?: LogFields): void;
  error(eventOrFields: string | LogFields, maybeFields?: LogFields): void {
    if (typeof eventOrFields === 'string') {
      this.parent.error({ ...this.baseFields, event: eventOrFields, ...maybeFields });
    } else {
      this.parent.error({ ...this.baseFields, ...eventOrFields });
    }
  }

  warn(fields: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  warn(eventOrFields: string | LogFields, maybeFields?: LogFields): void {
    if (typeof eventOrFields === 'string') {
      this.parent.warn({ ...this.baseFields, event: eventOrFields, ...maybeFields });
    } else {
      this.parent.warn({ ...this.baseFields, ...eventOrFields });
    }
  }

  info(fields: LogFields): void;
  info(event: string, fields?: LogFields): void;
  info(eventOrFields: string | LogFields, maybeFields?: LogFields): void {
    if (typeof eventOrFields === 'string') {
      this.parent.info({ ...this.baseFields, event: eventOrFields, ...maybeFields });
    } else {
      this.parent.info({ ...this.baseFields, ...eventOrFields });
    }
  }

  debug(fields: LogFields): void;
  debug(event: string, fields?: LogFields): void;
  debug(eventOrFields: string | LogFields, maybeFields?: LogFields): void {
    if (typeof eventOrFields === 'string') {
      this.parent.debug({ ...this.baseFields, event: eventOrFields, ...maybeFields });
    } else {
      this.parent.debug({ ...this.baseFields, ...eventOrFields });
    }
  }
}

/** Singleton logger instance */
export const logger = new Logger();
