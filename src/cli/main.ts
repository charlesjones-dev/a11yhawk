#!/usr/bin/env node
/**
 * a11yhawk CLI entry point.
 *
 * Thin wrapper over the engine: parse argv, map flags + environment onto
 * ScanOptions, run the scan, write reports, translate outcomes to exit codes.
 * The parsing and mapping live in the pure, exported `parseCliArgs` and
 * `buildScanOptions` so they can be unit-tested without spawning a browser.
 *
 * Stream contract: progress and diagnostics go to stderr; structured report
 * JSON goes to stdout only under --stdout. This keeps `a11yhawk <url> --stdout`
 * pipeable. The engine's own logger is redirected to stderr for the same reason.
 *
 * Exit codes: 0 success, 1 --fail-below threshold not met, 2 scan error,
 * 3 configuration error.
 */
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { renderHtmlReport } from '../engine/html-report.js';
import { scan, ScanError } from '../engine/scan.js';
import type {
  OneShotScanOptions,
  ScanErrorCode,
  ScanLlmOptions,
  ScanProgressEvent,
  ScanReport,
} from '../engine/scan.js';
import type { LogContext, Logger, LogLevel } from '../logger/index.js';
import { runServe } from '../server/serve.js';
import type { ScanHeader, WcagLevel, WcagVersion } from '../types.js';
import { runDoctor } from './doctor.js';

export const EXIT_SUCCESS = 0;
export const EXIT_THRESHOLD = 1;
export const EXIT_SCAN_ERROR = 2;
export const EXIT_CONFIG = 3;

/** Thrown for any user-facing configuration mistake; maps to exit code 3. */
export class CliConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliConfigError';
  }
}

export type OutputFormat = 'json' | 'md' | 'html';
const VALID_FORMATS: readonly OutputFormat[] = ['json', 'md', 'html'];

/** Raw, validated scan flags before env fallback is applied. */
export interface ParsedScanFlags {
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  noLlm: boolean;
  wcag: WcagVersion;
  level: WcagLevel;
  /** Raw "Name: value" header strings, parsed later by buildScanOptions. */
  headers: string[];
  /** Raw comma-separated format list, parsed later by buildScanOptions. */
  format?: string;
  output?: string;
  stdout: boolean;
  open: boolean;
  failBelow?: number;
  allowPrivate: boolean;
  noAnnotate: boolean;
  noLighthouse: boolean;
  quiet: boolean;
  verbose: boolean;
}

export type ParsedCli =
  | { command: 'scan'; url: string; flags: ParsedScanFlags }
  | { command: 'serve'; serveArgv: string[] }
  | { command: 'doctor' }
  | { command: 'help' }
  | { command: 'version' };

/** Output/runtime settings that shape what the CLI does with a report. */
export interface CliRunConfig {
  formats: OutputFormat[];
  outputDir: string;
  stdout: boolean;
  open: boolean;
  failBelow: number | null;
  quiet: boolean;
  verbose: boolean;
}

export interface BuiltCli {
  scanOptions: OneShotScanOptions;
  run: CliRunConfig;
}

const SCAN_ARG_OPTIONS = {
  model: { type: 'string' },
  'api-key': { type: 'string' },
  'base-url': { type: 'string' },
  'no-llm': { type: 'boolean' },
  wcag: { type: 'string' },
  level: { type: 'string' },
  header: { type: 'string', multiple: true },
  format: { type: 'string' },
  output: { type: 'string' },
  stdout: { type: 'boolean' },
  open: { type: 'boolean' },
  'fail-below': { type: 'string' },
  'allow-private': { type: 'boolean' },
  'no-annotate': { type: 'boolean' },
  'no-lighthouse': { type: 'boolean' },
  quiet: { type: 'boolean' },
  verbose: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean' },
} as const;

/** Enforce an enum flag value, falling back to a default when unset. */
function validateEnum<T extends string>(
  flag: string,
  value: string | undefined,
  allowed: readonly T[],
  fallback: T,
): T {
  if (value === undefined) return fallback;
  if (!allowed.includes(value as T)) {
    throw new CliConfigError(`Invalid value for ${flag}: "${value}". Allowed: ${allowed.join(', ')}.`);
  }
  return value as T;
}

/**
 * Parse argv into a routed command. Detects the `serve` and `doctor`
 * subcommands before flag parsing (serve owns its own flags and is passed
 * through untouched), then parses scan-style flags for everything else.
 */
export function parseCliArgs(argv: string[]): ParsedCli {
  if (argv.length === 0) return { command: 'help' };

  const first = argv[0];
  if (first === 'serve') return { command: 'serve', serveArgv: argv.slice(1) };
  if (first === 'doctor') return { command: 'doctor' };

  let values: Record<string, unknown>;
  let positionals: string[];
  try {
    const parsed = parseArgs({ args: argv, options: SCAN_ARG_OPTIONS, allowPositionals: true, strict: true });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (error) {
    throw new CliConfigError(error instanceof Error ? error.message : String(error));
  }

  if (values.help === true) return { command: 'help' };
  if (values.version === true) return { command: 'version' };

  const wcag = validateEnum('--wcag', values.wcag as string | undefined, ['2.0', '2.1', '2.2'] as const, '2.1');
  const level = validateEnum('--level', values.level as string | undefined, ['A', 'AA', 'AAA'] as const, 'AA');

  let failBelow: number | undefined;
  const rawFailBelow = values['fail-below'] as string | undefined;
  if (rawFailBelow !== undefined) {
    const parsed = Number(rawFailBelow);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
      throw new CliConfigError(
        `Invalid value for --fail-below: "${rawFailBelow}". Expected a number between 0 and 100.`,
      );
    }
    failBelow = parsed;
  }

  const flags: ParsedScanFlags = {
    model: values.model as string | undefined,
    apiKey: values['api-key'] as string | undefined,
    baseUrl: values['base-url'] as string | undefined,
    noLlm: values['no-llm'] === true,
    wcag,
    level,
    headers: (values.header as string[] | undefined) ?? [],
    format: values.format as string | undefined,
    output: values.output as string | undefined,
    stdout: values.stdout === true,
    open: values.open === true,
    failBelow,
    allowPrivate: values['allow-private'] === true,
    noAnnotate: values['no-annotate'] === true,
    noLighthouse: values['no-lighthouse'] === true,
    quiet: values.quiet === true,
    verbose: values.verbose === true,
  };

  if (flags.quiet && flags.verbose) {
    throw new CliConfigError('Cannot combine --quiet and --verbose.');
  }

  const [url, ...rest] = positionals;
  if (url === undefined) {
    throw new CliConfigError('No URL provided. Usage: a11yhawk <url> [options] (run "a11yhawk --help").');
  }
  if (rest.length > 0) {
    throw new CliConfigError(`Unexpected extra arguments: ${rest.join(' ')}. Provide a single URL.`);
  }

  return { command: 'scan', url, flags };
}

/** First value that is defined and non-blank; used for flag-then-env fallback. */
function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
  for (const value of values) {
    if (value !== undefined && value.trim() !== '') return value;
  }
  return undefined;
}

/** Parse one `Name: value` header string into a ScanHeader. */
export function parseHeaderArg(raw: string): ScanHeader {
  const separator = raw.indexOf(':');
  if (separator === -1) {
    throw new CliConfigError(`Invalid --header "${raw}": expected "Name: value".`);
  }
  const key = raw.slice(0, separator).trim();
  const value = raw.slice(separator + 1).trim();
  if (key === '') {
    throw new CliConfigError(`Invalid --header "${raw}": header name is empty.`);
  }
  return { type: 'header', key, value };
}

/** Parse and validate the --format list, defaulting to json + md. */
export function parseFormatList(raw: string | undefined): OutputFormat[] {
  if (raw === undefined) return ['json', 'md'];
  const parts = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  if (parts.length === 0) return ['json', 'md'];

  const formats: OutputFormat[] = [];
  for (const part of parts) {
    if (!VALID_FORMATS.includes(part as OutputFormat)) {
      throw new CliConfigError(`Unknown --format value "${part}". Valid formats: ${VALID_FORMATS.join(', ')}.`);
    }
    if (!formats.includes(part as OutputFormat)) formats.push(part as OutputFormat);
  }
  return formats;
}

/** Default output directory: ./a11yhawk-output/<timestamp> with dir-safe chars. */
function defaultOutputDir(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return join('.', 'a11yhawk-output', stamp);
}

/**
 * Map validated flags plus environment onto engine ScanOptions and CLI run
 * config. Flags always win over environment. The engine never reads env; this
 * is the only layer that does.
 */
export function buildScanOptions(flags: ParsedScanFlags, env: NodeJS.ProcessEnv): BuiltCli {
  const apiKey = firstNonEmpty(flags.apiKey, env.A11YHAWK_API_KEY);
  const model = firstNonEmpty(flags.model, env.A11YHAWK_MODEL);
  const baseUrl = firstNonEmpty(flags.baseUrl, env.A11YHAWK_BASE_URL);
  const allowPrivate = flags.allowPrivate || env.A11YHAWK_ALLOW_PRIVATE === 'true';
  const disableSandbox = env.A11YHAWK_DISABLE_SANDBOX === 'true';

  const llmMode = apiKey !== undefined && !flags.noLlm;
  const runLighthouse = !flags.noLighthouse;

  if (!llmMode && !runLighthouse) {
    throw new CliConfigError(
      flags.noLlm
        ? 'Nothing to analyze: --no-llm and --no-lighthouse together leave no analysis source.'
        : 'Nothing to analyze: --no-lighthouse needs an API key for LLM analysis. Set --api-key / A11YHAWK_API_KEY or drop --no-lighthouse.',
    );
  }

  const headers = flags.headers.map(parseHeaderArg);

  let formats = parseFormatList(flags.format);
  if (flags.open && !formats.includes('html')) {
    formats = [...formats, 'html'];
  }

  const scanOptions: OneShotScanOptions = {
    wcagVersion: flags.wcag,
    wcagLevel: flags.level,
    lighthouse: runLighthouse,
    annotate: !flags.noAnnotate,
    allowPrivateNetworks: allowPrivate,
  };
  if (headers.length > 0) scanOptions.headers = headers;

  const browser: NonNullable<OneShotScanOptions['browser']> = {};
  if (disableSandbox) browser.disableSandbox = true;
  if (flags.verbose) browser.debug = true;
  if (Object.keys(browser).length > 0) scanOptions.browser = browser;

  if (llmMode && apiKey !== undefined) {
    const llm: ScanLlmOptions = { apiKey };
    if (model !== undefined) llm.model = model;
    if (baseUrl !== undefined) llm.baseUrl = baseUrl;
    if (flags.verbose) llm.debug = true;
    scanOptions.llm = llm;
  }

  const run: CliRunConfig = {
    formats,
    outputDir: flags.output ?? defaultOutputDir(),
    stdout: flags.stdout,
    open: flags.open,
    failBelow: flags.failBelow ?? null,
    quiet: flags.quiet,
    verbose: flags.verbose,
  };

  return { scanOptions, run };
}

/**
 * Exit code for each ScanError code. All scan-time failures map to 2 per the
 * CLI contract (configuration mistakes are caught earlier and exit 3). Typed as
 * a total Record so adding a ScanErrorCode without mapping it fails to compile.
 */
export const EXIT_FOR_SCAN_ERROR: Record<ScanErrorCode, number> = {
  'invalid-options': EXIT_SCAN_ERROR,
  'invalid-url': EXIT_SCAN_ERROR,
  'blocked-request': EXIT_SCAN_ERROR,
  'capture-failed': EXIT_SCAN_ERROR,
  'lighthouse-failed': EXIT_SCAN_ERROR,
  'llm-auth': EXIT_SCAN_ERROR,
  'llm-rate-limit': EXIT_SCAN_ERROR,
  'llm-failed': EXIT_SCAN_ERROR,
  'llm-malformed': EXIT_SCAN_ERROR,
};

export function exitCodeForScanError(code: ScanErrorCode): number {
  return EXIT_FOR_SCAN_ERROR[code] ?? EXIT_SCAN_ERROR;
}

/** Whether a score trips the --fail-below CI gate. A score equal to the
 * threshold passes; only strictly-below fails. Null threshold never fails. */
export function failsThreshold(score: number, failBelow: number | null): boolean {
  return failBelow !== null && score < failBelow;
}

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/**
 * Logger that writes every level to stderr. The default engine logger writes
 * info/debug to stdout, which would corrupt --stdout JSON; routing to stderr
 * keeps stdout reserved for the report.
 */
function createCliLogger(level: LogLevel): Logger {
  const emit = (entryLevel: LogLevel, message: string, context?: LogContext): void => {
    if (LEVEL_RANK[entryLevel] < LEVEL_RANK[level]) return;
    const suffix = context && Object.keys(context).length > 0 ? ` ${JSON.stringify(context)}` : '';
    process.stderr.write(`${entryLevel}: ${message}${suffix}\n`);
  };
  const logger: Logger = {
    debug: (message, context) => emit('debug', message, context),
    info: (message, context) => emit('info', message, context),
    warn: (message, context) => emit('warn', message, context),
    error: (message, context) => emit('error', message, context),
    child: () => logger,
    flush: async () => {},
  };
  return logger;
}

/** One-line end-of-scan summary for stderr. */
function summaryLine(report: ScanReport, run: CliRunConfig): string {
  const score = report.structured.overallScore;
  const issues = report.structured.statistics.totalIssues;
  const where = run.stdout ? 'stdout' : run.outputDir;
  return `Score ${score}/100, ${issues} issue${issues === 1 ? '' : 's'}. Output: ${where}`;
}

/** Write reports to stdout (structured JSON) or to the output directory. */
async function emitOutputs(report: ScanReport, run: CliRunConfig): Promise<void> {
  if (run.stdout) {
    process.stdout.write(`${JSON.stringify(report.structured, null, 2)}\n`);
    if (run.open) {
      process.stderr.write('Note: --open is ignored with --stdout (no report file is written).\n');
    }
    return;
  }

  await mkdir(run.outputDir, { recursive: true });

  if (run.formats.includes('json')) {
    await writeFile(join(run.outputDir, 'report.json'), `${JSON.stringify(report.structured, null, 2)}\n`);
  }
  if (run.formats.includes('md')) {
    await writeFile(join(run.outputDir, 'report.md'), report.markdown);
  }
  let htmlPath: string | undefined;
  if (run.formats.includes('html')) {
    htmlPath = join(run.outputDir, 'report.html');
    await writeFile(htmlPath, renderHtmlReport(report));
  }
  if (report.screenshot) {
    await writeFile(join(run.outputDir, 'screenshot.jpg'), report.screenshot);
  }
  if (report.annotatedScreenshot) {
    await writeFile(join(run.outputDir, 'annotated.jpg'), report.annotatedScreenshot);
  }

  if (run.open && htmlPath !== undefined) {
    openInBrowser(htmlPath);
  }
}

/** Open a file with the platform's default handler. shell:false, never awaited. */
function openInBrowser(filePath: string): void {
  let command: string;
  let args: string[];
  if (process.platform === 'darwin') {
    command = 'open';
    args = [filePath];
  } else if (process.platform === 'win32') {
    command = 'cmd';
    args = ['/c', 'start', '', filePath];
  } else {
    command = 'xdg-open';
    args = [filePath];
  }
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true, shell: false });
    child.on('error', () => process.stderr.write(`Could not open ${filePath} automatically.\n`));
    child.unref();
  } catch {
    process.stderr.write(`Could not open ${filePath} automatically.\n`);
  }
}

async function runScan(url: string, flags: ParsedScanFlags, env: NodeJS.ProcessEnv): Promise<number> {
  let built: BuiltCli;
  try {
    built = buildScanOptions(flags, env);
  } catch (error) {
    if (error instanceof CliConfigError) {
      process.stderr.write(`Error: ${error.message}\n`);
      return EXIT_CONFIG;
    }
    throw error;
  }
  const { scanOptions, run } = built;

  scanOptions.logger = createCliLogger(run.verbose ? 'debug' : run.quiet ? 'error' : 'info');
  scanOptions.onProgress = (event: ScanProgressEvent) => {
    if (!run.quiet) process.stderr.write(`[${event.stage}] ${event.message}\n`);
  };

  let report: ScanReport;
  try {
    report = await scan(url, scanOptions);
  } catch (error) {
    if (error instanceof ScanError) {
      process.stderr.write(`[${error.code}] ${error.message}\n`);
      return exitCodeForScanError(error.code);
    }
    process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_SCAN_ERROR;
  }

  try {
    await emitOutputs(report, run);
  } catch (error) {
    process.stderr.write(`Error writing output: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_SCAN_ERROR;
  }

  if (!run.quiet) {
    process.stderr.write(`${summaryLine(report, run)}\n`);
  }

  if (failsThreshold(report.structured.overallScore, run.failBelow)) {
    process.stderr.write(
      `Score ${report.structured.overallScore} is below the --fail-below threshold of ${run.failBelow}.\n`,
    );
    return EXIT_THRESHOLD;
  }

  return EXIT_SUCCESS;
}

/** Read the package version via createRequire (works from src and dist). */
function readVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('../../package.json') as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const HELP_TEXT = `a11yhawk - open-source accessibility scan engine

Usage:
  a11yhawk <url> [options]     Scan a URL (default command)
  a11yhawk serve [options]     Run the HTTP server
  a11yhawk doctor              Check Chromium, Lighthouse, and key configuration
  a11yhawk --help              Show this help
  a11yhawk --version           Print the version

Scan options:
  --model <id>            LLM model id (env: A11YHAWK_MODEL)
  --api-key <key>         LLM API key (env: A11YHAWK_API_KEY)
  --base-url <url>        OpenAI-compatible endpoint (env: A11YHAWK_BASE_URL)
  --no-llm                Lighthouse-only mode (no LLM analysis)
  --wcag <2.0|2.1|2.2>    WCAG version (default: 2.1)
  --level <A|AA|AAA>      Conformance level (default: AA)
  --header "Name: value"  Custom request header (repeatable)
  --format <list>         Comma-separated: json,md,html (default: json,md)
  --output <dir>          Output directory (default: ./a11yhawk-output/<timestamp>)
  --stdout                Print structured JSON to stdout instead of writing files
  --open                  Open report.html after writing (implies html format)
  --fail-below <score>    Exit 1 when overallScore < score (CI gate)
  --allow-private         Permit scanning private/internal network targets
  --no-annotate           Skip screenshot annotation
  --no-lighthouse         Skip the Lighthouse audit (LLM mode only)
  --quiet                 Errors only
  --verbose               Debug logging

Exit codes:
  0  success
  1  --fail-below threshold not met
  2  scan error
  3  configuration error

LLM mode is enabled when an API key is present (flag or env) and --no-llm is
absent; otherwise a11yhawk runs Lighthouse-only. Progress is written to stderr,
so "a11yhawk <url> --stdout" pipes clean JSON on stdout.`;

function printHelp(): void {
  process.stdout.write(`${HELP_TEXT}\n`);
}

/** Route a parsed command to its handler and return the process exit code. */
export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let parsed: ParsedCli;
  try {
    parsed = parseCliArgs(argv);
  } catch (error) {
    if (error instanceof CliConfigError) {
      process.stderr.write(`Error: ${error.message}\n`);
      return EXIT_CONFIG;
    }
    throw error;
  }

  switch (parsed.command) {
    case 'help':
      printHelp();
      return EXIT_SUCCESS;
    case 'version':
      process.stdout.write(`${readVersion()}\n`);
      return EXIT_SUCCESS;
    case 'doctor':
      return runDoctor(env);
    case 'serve':
      try {
        await runServe(parsed.serveArgv);
        return EXIT_SUCCESS;
      } catch (error) {
        process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
        return EXIT_SCAN_ERROR;
      }
    case 'scan':
      return runScan(parsed.url, parsed.flags, env);
  }
}

/** True when this module is the process entry point (not imported by a test). */
function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  void main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`Fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
      process.exitCode = EXIT_SCAN_ERROR;
    },
  );
}
