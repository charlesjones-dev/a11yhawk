/**
 * Logger Types
 *
 * Provides TypeScript interfaces for structured logging across
 * the A11yHawk engine, CLI, and server surfaces.
 */

/**
 * Log severity levels in order of increasing severity
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Environment types for deployment context
 */
export type Environment = 'development' | 'staging' | 'production' | 'test';

/**
 * Service name for identifying log sources.
 *
 * Conventionally one of 'engine', 'cli', or 'server', but kept as a plain
 * string so hosts embedding the engine can tag logs with any label.
 */
export type ServiceName = string;

/**
 * Context object attached to log entries for traceability
 *
 * All fields are optional to allow flexible usage, but including
 * relevant identifiers helps with log correlation and debugging.
 */
export interface LogContext {
  /** Service producing the log (engine, cli, server) */
  service?: ServiceName;

  /** Deployment environment */
  environment?: Environment;

  /** Unique request identifier for tracing HTTP requests */
  requestId?: string;

  /** BullMQ job ID for scan processing */
  jobId?: string;

  /** MongoDB scan document ID */
  scanId?: string;

  /** User ID performing the action */
  userId?: string;

  /** Project ID associated with the action */
  projectId?: string;

  /** Schedule ID for scheduled scan operations */
  scheduleId?: string;

  /** Batch ID for multi-page scans */
  batchId?: string;

  /** Team ID for team-related operations */
  teamId?: string;

  /** Duration in milliseconds for timing operations */
  durationMs?: number;

  /** HTTP status code for request/response logging */
  statusCode?: number;

  /** HTTP method (GET, POST, etc.) */
  method?: string;

  /** Request path or URL */
  path?: string;

  /** Error name/type for error logging */
  errorName?: string;

  /** Error stack trace (sanitized) */
  errorStack?: string;

  /** Additional arbitrary context data */
  [key: string]: unknown;
}

/**
 * Configuration for the logger instance
 */
export interface LoggerConfig {
  /** Minimum log level to emit (logs below this level are ignored) */
  level: LogLevel;

  /** Service name for log identification */
  serviceName: ServiceName;

  /** Deployment environment */
  environment: Environment;

  /** Enable/disable log sanitization (defaults to true) */
  sanitize?: boolean;
}

/**
 * Structure of a structured log entry
 */
export interface LogEntry {
  /** ISO 8601 timestamp */
  timestamp: string;

  /** Log level */
  level: LogLevel;

  /** Human-readable log message */
  message: string;

  /** Context data attached to the log */
  context?: LogContext;

  /** Service producing the log */
  service: ServiceName;

  /** Deployment environment */
  environment: Environment;
}

/**
 * Logger interface for dependency injection and testing
 */
export interface Logger {
  /** Log a debug message (development-level detail) */
  debug(message: string, context?: LogContext): void;

  /** Log an info message (normal operational messages) */
  info(message: string, context?: LogContext): void;

  /** Log a warning message (unexpected but non-critical issues) */
  warn(message: string, context?: LogContext): void;

  /** Log an error message (critical issues requiring attention) */
  error(message: string, context?: LogContext): void;

  /** Create a child logger with additional default context */
  child(context: LogContext): Logger;

  /** Flush any pending logs (for graceful shutdown) */
  flush(): Promise<void>;
}

/**
 * Numeric log level values for comparison
 */
export const LOG_LEVEL_VALUES: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * Check if a log level should be emitted given the configured minimum level
 */
export function shouldLog(level: LogLevel, minLevel: LogLevel): boolean {
  return LOG_LEVEL_VALUES[level] >= LOG_LEVEL_VALUES[minLevel];
}
