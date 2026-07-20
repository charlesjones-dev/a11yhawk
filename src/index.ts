/**
 * a11yhawk: open-source, self-hostable web accessibility scan engine.
 *
 * Under active development. The public API (scan, A11yHawkEngine,
 * renderHtmlReport) lands with the engine extraction; until then the
 * package exports a placeholder that fails loudly rather than silently.
 */
export function scan(): never {
  throw new Error(
    'a11yhawk is under active development and not yet functional. ' +
      'Watch https://github.com/charlesjones-dev/a11yhawk for the first working release.',
  );
}
