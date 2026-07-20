# A11yHawk examples

Runnable scripts demonstrating the library API. Each one imports `a11yhawk` by package name, so the code is identical to what you would write in your own project.

## Running from this repo

```sh
npm install
npx playwright install chromium
npm run build          # examples resolve 'a11yhawk' to the local dist/ build
node examples/local-fixture.mjs
```

## The scripts

| Script                         | Needs an API key?          | What it shows                                                                                                                             |
| ------------------------------ | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `local-fixture.mjs`            | no                         | Fully self-contained demo: serves a deliberately broken page on localhost, scans it (Lighthouse-only), writes an HTML report. Start here. |
| `lighthouse-only.mjs <url>`    | no                         | Free deterministic scan of any public URL, summary to stdout                                                                              |
| `full-scan.mjs <url>`          | yes (`OPENROUTER_API_KEY`) | Full AI analysis with progress events; writes JSON, markdown, HTML, and screenshots to `examples/output/`                                 |
| `ci-gate.mjs <url> <minScore>` | no                         | CI gating pattern: exits 1 when the score is below the threshold                                                                          |

Outputs land in `examples/output/` (gitignored).

## Deployment templates

Not scripts, but copy-paste starting points:

- `docker-compose.yml` - run the A11yHawk HTTP server (`a11yhawk serve`) as a container; see the main README's Server mode section.
- `github-action.yml` - a GitHub Actions job template gating CI on an accessibility score with `npx a11yhawk --fail-below`. Copy it into your repo's `.github/workflows/` and adjust the URL and threshold.

## LLM mode notes

`full-scan.mjs` reads `OPENROUTER_API_KEY` from the environment. Any OpenAI-compatible endpoint works via `llm.baseUrl`; see the main README. LLM scans take one to several minutes and cost tokens on your key.
