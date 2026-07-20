/**
 * `a11yhawk doctor` - environment readiness checks.
 *
 * Verifies the pieces a scan needs before the user hits a mid-scan failure:
 * a supported Node.js, a usable Playwright Chromium, and a resolvable
 * Lighthouse CLI. The API key is reported for information only: Lighthouse-only
 * mode needs no key, so a missing key is never a failure.
 *
 * Exit code is the contract the CLI relies on: 0 when a scan can run at all
 * (Lighthouse-only counts), 3 when it cannot.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

import { chromium } from 'playwright';

const EXIT_OK = 0;
const EXIT_CONFIG = 3;

interface DoctorCheck {
  name: string;
  /** Whether the check passed. Informational checks are always true. */
  ok: boolean;
  /** Short human-readable detail (path found, version, etc.). */
  detail: string;
  /** Exact command or action that fixes a failure. */
  fix?: string;
  /** Informational checks never affect the exit code (e.g. API key presence). */
  informational?: boolean;
}

/** Node.js must be >= 20 (the package's declared engine). */
function checkNode(): DoctorCheck {
  const major = Number(process.versions.node.split('.')[0] ?? '0');
  const ok = major >= 20;
  return {
    name: 'Node.js >= 20',
    ok,
    detail: `found ${process.versions.node}`,
    fix: ok ? undefined : 'Install Node.js 20 or newer.',
  };
}

/**
 * Browser downloads are pinned per Playwright version, so the fix command must
 * run the exact Playwright this package bundles: a bare `npx playwright
 * install` outside a project resolves the registry's latest and downloads
 * browser builds this package cannot use.
 */
function chromiumFixCommand(): string {
  try {
    const require = createRequire(import.meta.url);
    const { version } = require('playwright/package.json') as { version?: string };
    if (version) {
      return `npx playwright@${version} install chromium`;
    }
  } catch {
    // Unresolvable playwright package; fall through to the unpinned command.
  }
  return 'npx playwright install chromium';
}

/**
 * Playwright must have a Chromium executable on disk. executablePath() returns
 * the expected location whether or not the download has run, so an explicit
 * existence check is what actually tells us it is installed.
 */
function checkChromium(): DoctorCheck {
  let execPath: string;
  try {
    execPath = chromium.executablePath();
  } catch {
    execPath = '';
  }
  const ok = execPath !== '' && existsSync(execPath);
  return {
    name: 'Playwright Chromium',
    ok,
    detail: ok ? execPath : execPath || 'not found',
    fix: ok ? undefined : chromiumFixCommand(),
  };
}

/**
 * The Lighthouse CLI entry must be resolvable from the installed package. This
 * mirrors the resolution used by the engine (createRequire on the package's own
 * package.json) so doctor fails for the same reasons a real audit would.
 */
function checkLighthouse(): DoctorCheck {
  try {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve('lighthouse/package.json');
    const pkg = require(pkgPath) as { bin?: string | Record<string, string> };
    const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.lighthouse;
    if (!bin) {
      return {
        name: 'Lighthouse CLI',
        ok: false,
        detail: 'package resolved but no CLI bin entry found',
        fix: 'Reinstall a11yhawk so a complete lighthouse dependency is present.',
      };
    }
    return { name: 'Lighthouse CLI', ok: true, detail: pkgPath };
  } catch {
    return {
      name: 'Lighthouse CLI',
      ok: false,
      detail: 'not resolvable',
      fix: 'Reinstall a11yhawk so its lighthouse dependency is present.',
    };
  }
}

/** API key presence is informational: Lighthouse-only mode needs none. */
function checkApiKey(env: NodeJS.ProcessEnv): DoctorCheck {
  const configured = Boolean(env.A11YHAWK_API_KEY && env.A11YHAWK_API_KEY.trim());
  return {
    name: 'LLM API key (A11YHAWK_API_KEY)',
    ok: true,
    informational: true,
    detail: configured ? 'configured (LLM analysis available)' : 'not set (Lighthouse-only mode)',
  };
}

/**
 * Run every check, print a report to stdout, and return the process exit code.
 * A scan can run when Node, Chromium, and Lighthouse are all healthy, which is
 * exactly the Lighthouse-only path.
 */
export async function runDoctor(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const checks: DoctorCheck[] = [checkNode(), checkChromium(), checkLighthouse(), checkApiKey(env)];

  const lines: string[] = ['a11yhawk doctor', ''];
  for (const check of checks) {
    const mark = check.informational ? 'i' : check.ok ? 'ok' : 'x';
    lines.push(`  [${mark}] ${check.name}: ${check.detail}`);
    if (!check.ok && check.fix) {
      lines.push(`        fix: ${check.fix}`);
    }
  }
  lines.push('');

  const canScan = checks.filter((c) => !c.informational).every((c) => c.ok);
  lines.push(
    canScan
      ? 'Ready: scans can run (Lighthouse-only works with no API key).'
      : 'Not ready: resolve the failures above before scanning.',
  );

  process.stdout.write(`${lines.join('\n')}\n`);
  return canScan ? EXIT_OK : EXIT_CONFIG;
}
