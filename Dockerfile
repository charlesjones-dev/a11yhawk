# syntax=docker/dockerfile:1

# a11yhawk container image.
#
# Base is the official Playwright image whose tag is pinned to the exact
# `playwright` dependency version (1.57.0): it bakes in a matching Chromium plus
# every system library the browser and Lighthouse need. Building on anything
# else means fighting missing shared libraries.
#
# Multi-stage: the build stage compiles TypeScript to dist/ with the full
# dependency tree; the runtime stage carries only production dependencies and
# the compiled output, and runs as the image's non-root pwuser with the
# Chromium sandbox left enabled.

# ---- build stage ------------------------------------------------------------
FROM mcr.microsoft.com/playwright:v1.57.0-noble AS build

WORKDIR /app

# Install with the lockfile first so this layer caches across source-only edits.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- runtime stage ----------------------------------------------------------
FROM mcr.microsoft.com/playwright:v1.57.0-noble AS runtime

ENV NODE_ENV=production
# Default listen port; overridable at runtime. Kept in sync with EXPOSE below.
ENV A11YHAWK_PORT=4000

WORKDIR /app

# Production dependencies only. Browsers are already present in the base image,
# and the `playwright` npm package does not download browsers on install, so no
# network browser fetch happens here.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# Own the app dir as the unprivileged user baked into the Playwright image, then
# drop to it. Running as non-root keeps the Chromium sandbox usable.
RUN chown -R pwuser:pwuser /app
USER pwuser

EXPOSE 4000

# Liveness via the always-open /healthz endpoint (no auth token required there).
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.A11YHAWK_PORT||4000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# `serve` is the default; `docker run <image> https://example.com` runs a
# one-shot scan instead by overriding the command.
ENTRYPOINT ["node", "dist/cli/main.js"]
CMD ["serve"]
