import { describe, expect, it } from 'vitest';

import type { ScanErrorCode } from '../engine/scan.js';
import {
  buildScanOptions,
  CliConfigError,
  EXIT_FOR_SCAN_ERROR,
  EXIT_SCAN_ERROR,
  exitCodeForScanError,
  failsThreshold,
  parseCliArgs,
  parseFormatList,
  parseHeaderArg,
  type ParsedScanFlags,
} from './main.js';

/** Parse argv and assert it routed to a scan, returning the parsed flags. */
function flagsFor(argv: string[]): ParsedScanFlags {
  const parsed = parseCliArgs(argv);
  if (parsed.command !== 'scan') {
    throw new Error(`expected scan command, got ${parsed.command}`);
  }
  return parsed.flags;
}

describe('parseCliArgs command routing', () => {
  it('routes empty argv to help', () => {
    expect(parseCliArgs([])).toEqual({ command: 'help' });
  });

  it('routes --help and -h to help', () => {
    expect(parseCliArgs(['--help'])).toEqual({ command: 'help' });
    expect(parseCliArgs(['-h'])).toEqual({ command: 'help' });
  });

  it('routes --version to version', () => {
    expect(parseCliArgs(['--version'])).toEqual({ command: 'version' });
  });

  it('routes doctor', () => {
    expect(parseCliArgs(['doctor'])).toEqual({ command: 'doctor' });
  });

  it('passes remaining argv through to serve without parsing it', () => {
    expect(parseCliArgs(['serve', '--port', '3000', '--anything'])).toEqual({
      command: 'serve',
      serveArgv: ['--port', '3000', '--anything'],
    });
  });

  it('routes a bare URL to scan with defaults', () => {
    const parsed = parseCliArgs(['https://example.com']);
    expect(parsed.command).toBe('scan');
    const flags = flagsFor(['https://example.com']);
    expect(flags.wcag).toBe('2.1');
    expect(flags.level).toBe('AA');
    expect(flags.headers).toEqual([]);
    expect(flags.noLlm).toBe(false);
    expect(flags.stdout).toBe(false);
  });

  it('rejects an unknown flag', () => {
    expect(() => parseCliArgs(['https://example.com', '--nope'])).toThrow(CliConfigError);
  });

  it('rejects a missing URL', () => {
    expect(() => parseCliArgs(['--format', 'json'])).toThrow(CliConfigError);
  });

  it('rejects more than one positional', () => {
    expect(() => parseCliArgs(['https://a.example', 'https://b.example'])).toThrow(/extra arguments/);
  });

  it('rejects combining --quiet and --verbose', () => {
    expect(() => parseCliArgs(['https://example.com', '--quiet', '--verbose'])).toThrow(CliConfigError);
  });
});

describe('parseCliArgs flag parsing', () => {
  it('collects repeatable --header flags in order', () => {
    const flags = flagsFor(['https://example.com', '--header', 'X-A: 1', '--header', 'X-B: 2']);
    expect(flags.headers).toEqual(['X-A: 1', 'X-B: 2']);
  });

  it('validates --wcag against the allowed set', () => {
    expect(flagsFor(['https://example.com', '--wcag', '2.2']).wcag).toBe('2.2');
    expect(() => parseCliArgs(['https://example.com', '--wcag', '9.9'])).toThrow(/Invalid value for --wcag/);
  });

  it('validates --level against the allowed set', () => {
    expect(flagsFor(['https://example.com', '--level', 'AAA']).level).toBe('AAA');
    expect(() => parseCliArgs(['https://example.com', '--level', 'B'])).toThrow(/Invalid value for --level/);
  });

  it('parses --fail-below as a number and rejects bad values', () => {
    expect(flagsFor(['https://example.com', '--fail-below', '80']).failBelow).toBe(80);
    expect(() => parseCliArgs(['https://example.com', '--fail-below', 'abc'])).toThrow(/fail-below/);
    expect(() => parseCliArgs(['https://example.com', '--fail-below', '150'])).toThrow(/fail-below/);
  });
});

describe('parseHeaderArg', () => {
  it('splits on the first colon and trims', () => {
    expect(parseHeaderArg('Authorization: Bearer abc')).toEqual({
      type: 'header',
      key: 'Authorization',
      value: 'Bearer abc',
    });
  });

  it('keeps colons in the value', () => {
    expect(parseHeaderArg('X-Time: 12:30:00')).toEqual({ type: 'header', key: 'X-Time', value: '12:30:00' });
  });

  it('rejects a header with no colon', () => {
    expect(() => parseHeaderArg('NotAHeader')).toThrow(CliConfigError);
  });

  it('rejects a header with an empty name', () => {
    expect(() => parseHeaderArg(': value')).toThrow(CliConfigError);
  });
});

describe('parseFormatList', () => {
  it('defaults to json and md', () => {
    expect(parseFormatList(undefined)).toEqual(['json', 'md']);
    expect(parseFormatList('')).toEqual(['json', 'md']);
  });

  it('parses and dedupes a valid list', () => {
    expect(parseFormatList('json,html')).toEqual(['json', 'html']);
    expect(parseFormatList('json,json,md')).toEqual(['json', 'md']);
  });

  it('rejects an unknown format', () => {
    expect(() => parseFormatList('pdf')).toThrow(/Unknown --format value/);
    expect(() => parseFormatList('json,pdf')).toThrow(/Unknown --format value/);
  });
});

describe('buildScanOptions env fallback and precedence', () => {
  it('prefers the flag over the environment for the API key', () => {
    const flags = flagsFor(['https://example.com', '--api-key', 'flagkey']);
    const { scanOptions } = buildScanOptions(flags, { A11YHAWK_API_KEY: 'envkey' });
    expect(scanOptions.llm?.apiKey).toBe('flagkey');
  });

  it('falls back to the environment when the flag is absent', () => {
    const flags = flagsFor(['https://example.com']);
    const { scanOptions } = buildScanOptions(flags, {
      A11YHAWK_API_KEY: 'envkey',
      A11YHAWK_MODEL: 'env/model',
      A11YHAWK_BASE_URL: 'https://env.example/v1',
    });
    expect(scanOptions.llm?.apiKey).toBe('envkey');
    expect(scanOptions.llm?.model).toBe('env/model');
    expect(scanOptions.llm?.baseUrl).toBe('https://env.example/v1');
  });

  it('runs Lighthouse-only when no key is present anywhere', () => {
    const { scanOptions } = buildScanOptions(flagsFor(['https://example.com']), {});
    expect(scanOptions.llm).toBeUndefined();
    expect(scanOptions.lighthouse).toBe(true);
  });

  it('drops LLM mode when --no-llm is set even with a key', () => {
    const flags = flagsFor(['https://example.com', '--no-llm']);
    const { scanOptions } = buildScanOptions(flags, { A11YHAWK_API_KEY: 'envkey' });
    expect(scanOptions.llm).toBeUndefined();
  });

  it('honors A11YHAWK_ALLOW_PRIVATE and the flag', () => {
    expect(buildScanOptions(flagsFor(['https://example.com']), {}).scanOptions.allowPrivateNetworks).toBe(false);
    expect(
      buildScanOptions(flagsFor(['https://example.com']), { A11YHAWK_ALLOW_PRIVATE: 'true' }).scanOptions
        .allowPrivateNetworks,
    ).toBe(true);
    expect(
      buildScanOptions(flagsFor(['https://example.com', '--allow-private']), {}).scanOptions.allowPrivateNetworks,
    ).toBe(true);
  });

  it('maps A11YHAWK_DISABLE_SANDBOX onto browser.disableSandbox', () => {
    const { scanOptions } = buildScanOptions(flagsFor(['https://example.com']), { A11YHAWK_DISABLE_SANDBOX: 'true' });
    expect(scanOptions.browser?.disableSandbox).toBe(true);
  });

  it('maps repeatable headers into ScanHeader objects', () => {
    const flags = flagsFor(['https://example.com', '--header', 'X-A: 1', '--header', 'X-B: 2']);
    const { scanOptions } = buildScanOptions(flags, {});
    expect(scanOptions.headers).toEqual([
      { type: 'header', key: 'X-A', value: '1' },
      { type: 'header', key: 'X-B', value: '2' },
    ]);
  });

  it('rejects a malformed header at build time', () => {
    const flags = flagsFor(['https://example.com', '--header', 'no-colon-here']);
    expect(() => buildScanOptions(flags, {})).toThrow(CliConfigError);
  });
});

describe('buildScanOptions contradictory modes', () => {
  it('errors when both --no-llm and --no-lighthouse are set', () => {
    const flags = flagsFor(['https://example.com', '--no-llm', '--no-lighthouse']);
    expect(() => buildScanOptions(flags, { A11YHAWK_API_KEY: 'k' })).toThrow(CliConfigError);
  });

  it('errors when --no-lighthouse is set without an API key', () => {
    const flags = flagsFor(['https://example.com', '--no-lighthouse']);
    expect(() => buildScanOptions(flags, {})).toThrow(/Nothing to analyze/);
  });

  it('allows --no-lighthouse with a key (LLM-only)', () => {
    const flags = flagsFor(['https://example.com', '--no-lighthouse', '--api-key', 'k']);
    const { scanOptions } = buildScanOptions(flags, {});
    expect(scanOptions.lighthouse).toBe(false);
    expect(scanOptions.llm?.apiKey).toBe('k');
  });
});

describe('buildScanOptions output config', () => {
  it('defaults formats to json,md and derives an output dir', () => {
    const { run } = buildScanOptions(flagsFor(['https://example.com']), {});
    expect(run.formats).toEqual(['json', 'md']);
    expect(run.outputDir).toMatch(/a11yhawk-output/);
    expect(run.failBelow).toBeNull();
  });

  it('adds html to formats when --open is set', () => {
    const flags = flagsFor(['https://example.com', '--open', '--format', 'json']);
    const { run } = buildScanOptions(flags, {});
    expect(run.formats).toContain('html');
    expect(run.open).toBe(true);
  });

  it('carries --output through', () => {
    const flags = flagsFor(['https://example.com', '--output', '/tmp/out']);
    expect(buildScanOptions(flags, {}).run.outputDir).toBe('/tmp/out');
  });
});

describe('failsThreshold', () => {
  it('fails only when strictly below the threshold', () => {
    expect(failsThreshold(79, 80)).toBe(true);
    expect(failsThreshold(80, 80)).toBe(false);
    expect(failsThreshold(81, 80)).toBe(false);
  });

  it('never fails when no threshold is set', () => {
    expect(failsThreshold(0, null)).toBe(false);
  });
});

describe('exitCodeForScanError', () => {
  const codes: ScanErrorCode[] = [
    'invalid-options',
    'invalid-url',
    'blocked-request',
    'capture-failed',
    'lighthouse-failed',
    'llm-auth',
    'llm-rate-limit',
    'llm-failed',
    'llm-malformed',
  ];

  it('maps every ScanError code to the scan-error exit code', () => {
    for (const code of codes) {
      expect(exitCodeForScanError(code)).toBe(EXIT_SCAN_ERROR);
    }
  });

  it('has a mapping for exactly the known codes (no gaps, no extras)', () => {
    expect(Object.keys(EXIT_FOR_SCAN_ERROR).sort()).toEqual([...codes].sort());
  });
});
