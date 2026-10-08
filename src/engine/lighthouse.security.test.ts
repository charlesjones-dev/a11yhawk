/**
 * Security regression tests for the Lighthouse subprocess: the scan URL stays one literal
 * argv element with no shell, the child gets an allowlisted environment instead of the
 * host's, and Lighthouse's error reporting is pinned off.
 */
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('child_process', () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }));
vi.mock('node:child_process', () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }));

import type { Logger } from '../logger/index.js';
import { buildLighthouseCliArgs, buildLighthouseEnv, LighthouseService } from './lighthouse.js';

const silent: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silent;
  },
  async flush() {},
};

interface SpawnCall {
  command: string;
  args: string[];
  options: { shell?: boolean; env?: Record<string, string | undefined> };
}

function fakeChild(): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; pid: number; kill: () => void } {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    pid: 4242,
    exitCode: null,
    signalCode: null,
    kill() {},
  });
  setImmediate(() => child.emit('close', 1, null));
  return child;
}

const HOSTILE_URL = 'https://example.com/;id;$(id)|whoami&x=`id`';

beforeEach(() => {
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => fakeChild());
});

afterEach(() => {
  delete process.env.A11YHAWK_API_KEY;
});

async function runOnce(url: string): Promise<SpawnCall> {
  const service = new LighthouseService(1000);
  await service.runAudit(url, { cdpPort: 9222 }, silent).catch(() => undefined);
  expect(spawnMock).toHaveBeenCalledTimes(1);
  const [command, args, options] = spawnMock.mock.calls[0] as [string, string[], SpawnCall['options']];
  return { command, args, options };
}

describe('shell injection through the Lighthouse URL', () => {
  it('spawns node + cli script with the URL as a single literal argv element and shell:false', async () => {
    const call = await runOnce(HOSTILE_URL);
    expect(call.command).toBe(process.execPath);
    expect(call.options.shell).toBe(false);
    expect(call.args[1]).toBe(HOSTILE_URL);
    expect(call.args.filter((a) => a.includes('id'))).toEqual([HOSTILE_URL]);
    expect(call.args[0]).toMatch(/lighthouse[\\/]cli[\\/]index\.js$/);
  });

  it('builds argv where the URL is positional and cannot add flags', () => {
    const args = buildLighthouseCliArgs(HOSTILE_URL, ['accessibility'], 9222);
    expect(args[0]).toBe(HOSTILE_URL);
    expect(args.slice(1).every((a) => a.startsWith('--'))).toBe(true);
  });
});

describe('Lighthouse child process hygiene', () => {
  it('does not pass the parent environment (and its secrets) to the Lighthouse child', async () => {
    process.env.A11YHAWK_API_KEY = 'CANARY-OPERATOR-LLM-KEY';
    const call = await runOnce('https://example.com/');
    expect(call.options.env?.A11YHAWK_API_KEY).toBeUndefined();
    expect(call.options.env?.CHROME_PATH).toBeTruthy();
  });

  it('passes only allowlisted variables plus CHROME_PATH', () => {
    const env = buildLighthouseEnv(
      { PATH: '/usr/bin', HOME: '/home/a', TMPDIR: '/tmp', NODE_OPTIONS: '--require ./x.js', OPENAI_API_KEY: 'k' },
      '/chrome',
    );
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/a', TMPDIR: '/tmp', CHROME_PATH: '/chrome' });
  });

  it('pins Lighthouse error reporting (Sentry upload) off on the command line', () => {
    for (const port of [9222, undefined]) {
      const args = buildLighthouseCliArgs('https://example.com/', ['accessibility'], port);
      expect(args).toContain('--no-enable-error-reporting');
      expect(args).not.toContain('--enable-error-reporting');
    }
  });
});
