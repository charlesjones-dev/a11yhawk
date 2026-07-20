/**
 * Logger Module - Console-based Structured Logging
 *
 * Provides structured logging via console output:
 * - Colorized console output in development
 * - Structured JSON output in production (one JSON object per line, ready for log aggregators)
 * - Service and environment tagging
 * - Child logger support for request/job context
 * - Automatic sanitization of sensitive data
 *
 * @module a11yhawk/logger
 */

import type { Logger as ILogger, LogContext, LoggerConfig, LogLevel, ServiceName, Environment } from './types.js';
import { sanitize } from './sanitizer.js';
import { shouldLog } from './types.js';

// Re-export types and sanitizer utilities
export * from './types.js';
export { sanitize, sanitizeString, sanitizeError, getMaskPlaceholder } from './sanitizer.js';

/**
 * Singleton logger instance
 */
let singletonLogger: A11yHawkLogger | null = null;

/**
 * Get environment variable with fallback
 */
function getEnv(key: string, fallback?: string): string | undefined {
  const value = process.env[key];
  if (!value || value.trim() === '') {
    return fallback;
  }
  return value;
}

/**
 * Parse log level from environment
 */
function parseLogLevel(level: string | undefined): LogLevel {
  const validLevels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
  if (level && validLevels.includes(level as LogLevel)) {
    return level as LogLevel;
  }
  return 'info';
}

/**
 * Parse service name from environment
 */
function parseServiceName(name: string | undefined): ServiceName {
  if (name && name.trim() !== '') {
    return name;
  }
  return 'engine';
}

/**
 * Parse environment from NODE_ENV
 */
function parseEnvironment(env: string | undefined): Environment {
  const validEnvs: Environment[] = ['development', 'staging', 'production', 'test'];
  if (env && validEnvs.includes(env as Environment)) {
    return env as Environment;
  }
  return 'development';
}

/**
 * Build logger configuration from environment variables
 */
function buildConfigFromEnv(overrides?: Partial<LoggerConfig>): LoggerConfig {
  return {
    level: overrides?.level ?? parseLogLevel(getEnv('LOG_LEVEL')),
    serviceName: overrides?.serviceName ?? parseServiceName(getEnv('LOG_SERVICE_NAME')),
    environment: overrides?.environment ?? parseEnvironment(getEnv('LOG_ENVIRONMENT') ?? getEnv('NODE_ENV')),
    sanitize: overrides?.sanitize ?? true,
  };
}

/**
 * Format a timestamp for dev console output
 */
function devTimestamp(): string {
  const now = new Date();
  return now.toTimeString().slice(0, 8); // HH:mm:ss
}

/**
 * ANSI color codes for log levels in development
 */
const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: '\x1b[36m', // cyan
  info: '\x1b[32m', // green
  warn: '\x1b[33m', // yellow
  error: '\x1b[31m', // red
};
const RESET = '\x1b[0m';

/**
 * A11yHawk Logger implementation
 *
 * Uses console methods directly, outputting structured JSON in production
 * (for downstream log aggregation) and colorized text in development.
 */
class A11yHawkLogger implements ILogger {
  private config: LoggerConfig;
  private defaultContext: LogContext;

  constructor(config: LoggerConfig, defaultContext: LogContext = {}) {
    this.config = config;
    this.defaultContext = {
      service: config.serviceName,
      environment: config.environment,
      ...defaultContext,
    };
  }

  /**
   * Internal log method with sanitization and context merging
   */
  private log(level: LogLevel, message: string, context?: LogContext): void {
    if (!shouldLog(level, this.config.level)) {
      return;
    }

    try {
      const mergedContext: LogContext = {
        ...this.defaultContext,
        ...context,
      };

      const safeContext = this.config.sanitize !== false ? (sanitize(mergedContext) as LogContext) : mergedContext;

      const isDev = this.config.environment === 'development' || this.config.environment === 'test';

      if (isDev) {
        this.logDev(level, message, safeContext);
      } else {
        this.logStructured(level, message, safeContext);
      }
    } catch (error) {
      console.error('[Logger] Failed to log:', error);
    }
  }

  /**
   * Colorized dev console output
   */
  private logDev(level: LogLevel, message: string, context: LogContext): void {
    const color = LEVEL_COLORS[level];
    const { service, ...meta } = context;
    delete meta.environment;
    const metaStr = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
    const line = `${devTimestamp()} [${service}] ${color}${level}${RESET}: ${message}${metaStr}`;

    const consoleFn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    consoleFn(line);
  }

  /**
   * Structured JSON output for downstream log aggregation
   */
  private logStructured(level: LogLevel, message: string, context: LogContext): void {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...context,
    };

    const consoleFn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    consoleFn(JSON.stringify(entry));
  }

  debug(message: string, context?: LogContext): void {
    this.log('debug', message, context);
  }

  info(message: string, context?: LogContext): void {
    this.log('info', message, context);
  }

  warn(message: string, context?: LogContext): void {
    this.log('warn', message, context);
  }

  error(message: string, context?: LogContext): void {
    this.log('error', message, context);
  }

  child(context: LogContext): ILogger {
    return new A11yHawkLogger(this.config, {
      ...this.defaultContext,
      ...context,
    });
  }

  async flush(): Promise<void> {
    // No-op — console output is synchronous, nothing to flush.
    // Kept for API compatibility with existing shutdown hooks.
  }
}

/**
 * Create a new logger instance with the given configuration
 */
export function createLogger(config?: Partial<LoggerConfig>): ILogger {
  const fullConfig = buildConfigFromEnv(config);
  return new A11yHawkLogger(fullConfig);
}

/**
 * Get the singleton logger instance
 */
export function getLogger(): ILogger {
  if (!singletonLogger) {
    singletonLogger = new A11yHawkLogger(buildConfigFromEnv());
  }
  return singletonLogger;
}

/**
 * Reset the singleton logger (useful for testing)
 *
 * @internal
 */
export function resetLogger(): void {
  singletonLogger = null;
}
