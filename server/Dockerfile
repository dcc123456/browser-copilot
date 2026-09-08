# Browser Copilot runner — server image.
# Base includes Playwright + Chromium + all OS deps; we add the repo and run
# via tsx (no build step needed — the runner imports the pure engine sources).
FROM mcr.microsoft.com/playwright:v1.59.1-noble

WORKDIR /app

# Install pnpm (repo toolchain) and copy manifests first for layer caching.
RUN npm install -g pnpm@11
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY server/package.json server/
RUN pnpm install --frozen-lockfile

# Copy the repo sources the server imports (pure engine + libs + server).
COPY server/ server/
COPY src/ src/
COPY tests/ tests/

ENV NODE_ENV=production \
    BC_DATA_DIR=/data \
    BC_WORKFLOWS_FILE=/data/workflows.json

# Data (workflows.json, runs, artifacts, profiles) lives in a volume.
VOLUME /data
EXPOSE 8787

WORKDIR /app/server
CMD ["pnpm", "exec", "tsx", "src/main.ts"]
