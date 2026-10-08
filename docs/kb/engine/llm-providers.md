---
tags: [llm, anthropic, openrouter, sdk, ssrf, pricing]
related: [[vitest]], [[dependency-audit]]
created: 2026-10-08
last-updated: 2026-10-08
pinned: false
scope: ['src/engine/llm.ts', 'src/engine/llm*.test.ts', 'src/engine/request-guard.ts']
---

# LLM Providers

How the LLM stage's two providers (OpenRouter via the OpenAI SDK, Anthropic via `@anthropic-ai/sdk`) are wired, and the SDK behaviors that shaped them (v0.7.0).

## Key Rules

- Keep the OpenRouter path identical when no `provider` is set: same request, headers, errors, and messages as 0.6.0. OpenRouter failures are classified by HTTP status in `scan.ts`; the Anthropic provider classifies its own by setting `LlmRequestError.code` and `retryable`.
- The Anthropic SDK reads `ANTHROPIC_*` env by default. Passing `apiKey`, `authToken: null`, `baseURL`, `webhookKey: null`, and `logLevel` skips most of it, but `ANTHROPIC_CUSTOM_HEADERS` is always merged into `_options.defaultHeaders`, after the auth headers, so it can replace `x-api-key`. `EnvIsolatedAnthropic` resets that protected field. This depends on SDK internals: on every SDK bump, grep `readEnv(` in `node_modules/@anthropic-ai/sdk/client.mjs` and keep the env test in `llm.anthropic.test.ts` passing.
- The SDK uses `fetch`, which has no agent hook, so the SSRF guard attaches through `createGuardedFetch`, a fetch over `node:http(s)` with the guarded agent. It never follows redirects and sends `accept-encoding: identity` (node:http does not decode). It calls `http.request(url, options, callback)`, so a test fake of `http.request` must invoke that callback, not just emit `response`.
- The SDK's `timeout` covers only the wait for response headers; a streamed body is untimed. The guarded fetch cuts a stream after 5 idle minutes, matching the built-in fetch's default body timeout.
- Top-level `usage` covers only the attempt that answered; `usage.iterations` lists every attempt after a refusal fallback (`message` for declined hops, `fallback_message` for the server). The stream helper copies `iterations` from `message_delta` and relabels `model` to the fallback block's `to.model`.
- Billing failures arrive as a 402 `billing_error`, or as a 429 whose `error.details.error_code` is `enforced_spend_limit_reached` (no `retry-after`). A spend limit the account owner sets is a 400 that only its message text identifies, so it stays non-retryable `llm-failed`; do not string-match it.
- `REFUSAL_FALLBACK_MODELS` is an exact-ID list (Fable 5.1/5, Mythos 5.1, Opus 5.5/5, Sonnet 5.5). Haiku 5.5 has no server-side fallback. Update the list when new models ship.
- Anthropic tiles are 1932 px: under 4784 visual tokens (28 px patches) and 2576 px on the high-resolution tier, so no downscaling, and under the 2000 px per-image limit for requests with more than 20 images. One request takes at most 100 images on every model. The OpenRouter tile lookup stays keyed by the model-ID prefix.
- The SDK exports no name for the `beta.messages.stream` params; use `Parameters<Anthropic['beta']['messages']['stream']>[0]`.
- Test the Anthropic client by partially mocking `./request-guard.js` so `createGuardedFetch` returns a mock fetch, and mock `dns/promises` so the engine runs in the default posture without network. Give canned error replies `x-should-retry: false`; a connection-error test still takes about 1.5 s for the SDK's 2 retries.
- Live checks: pass a key only as a process env var, never to a file; grep outputs for it and delete them afterwards. A call to the real API with a fake key is a free check of the guarded fetch over TLS (expect non-retryable `llm-auth`).
- Prompt size is not capped: a Wikipedia-size page sent about 343K prompt tokens (671 KB HTML, 600 KB accessibility tree), about $1.43 on Opus 5.5. Use a small page for live smoke tests.
- The "Screenshot split into N tiles" progress message fires only in browser debug mode; count tiles from `screenshotTiles`, not progress events.

## Related

- [[vitest]]
- [[dependency-audit]]
