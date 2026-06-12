# ─── Stage 1: deps ────────────────────────────────────────────────────────────
# Install dependencies using pnpm workspaces.
# We use corepack so the exact pnpm version is locked by the engine field.
FROM node:22-slim AS deps

# Enable corepack and pin pnpm to the version that produced lockfileVersion 9.
RUN corepack enable && corepack prepare pnpm@11 --activate

WORKDIR /app

# Copy workspace manifests and lockfile — needed so pnpm can resolve the
# workspace graph without copying all source files.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY tsconfig.base.json ./

# Copy every package's package.json.  We include admin/sdk/cloud stubs so that
# pnpm workspace resolution is identical to the dev install.
COPY backend/package.json ./backend/
COPY admin/package.json ./admin/
COPY sdk/package.json ./sdk/
COPY cloud/billing/package.json ./cloud/billing/

# Fetch all packages into the pnpm store (network step — cached unless lockfile changes).
RUN pnpm fetch --frozen-lockfile

# Install from the local store (offline, fast).
RUN pnpm install --frozen-lockfile --offline


# ─── Stage 2: build ───────────────────────────────────────────────────────────
FROM deps AS builder

WORKDIR /app

# Source for the backend
COPY backend/tsconfig.json ./backend/
COPY backend/src ./backend/src

# cloud/billing (backend may import @cartcrft/cloud-billing when CARTCRFT_CLOUD=1)
COPY cloud/billing/tsconfig.json ./cloud/billing/
COPY cloud/billing/src ./cloud/billing/src

# Build cloud/billing first so its dist/ is available if backend imports it.
RUN pnpm --filter @cartcrft/cloud-billing build

# Build the backend
RUN pnpm --filter backend build


# ─── Stage 3: runtime ─────────────────────────────────────────────────────────
FROM node:22-slim AS runtime

# Minimal runtime OS packages: dumb-init for correct signal forwarding.
RUN apt-get update && apt-get install -y --no-install-recommends \
    dumb-init \
  && rm -rf /var/lib/apt/lists/*

# Non-root user for security
RUN groupadd --gid 1001 cartcrft && \
    useradd --uid 1001 --gid cartcrft --shell /bin/bash --create-home cartcrft

WORKDIR /app

# ── Backend dist + runtime node_modules ──────────────────────────────────────
COPY --from=builder --chown=cartcrft:cartcrft /app/backend/dist ./backend/dist
COPY --from=builder --chown=cartcrft:cartcrft /app/backend/node_modules ./backend/node_modules
COPY --from=builder --chown=cartcrft:cartcrft /app/backend/package.json ./backend/package.json

# cloud/billing dist (only if cloud features are enabled at runtime)
COPY --from=builder --chown=cartcrft:cartcrft /app/cloud/billing/dist ./cloud/billing/dist
COPY --from=builder --chown=cartcrft:cartcrft /app/cloud/billing/package.json ./cloud/billing/package.json

# Workspace root node_modules (shared hoisted deps, if any)
COPY --from=builder --chown=cartcrft:cartcrft /app/node_modules ./node_modules

# Migrations — included so `node backend/dist/main.js migrate` can find them.
# The migrate runner resolves: backend/dist/main.js → ../../migrations → backend/migrations
COPY --chown=cartcrft:cartcrft backend/migrations ./backend/migrations

USER cartcrft

# Expose the default API port (overridden by the PORT env var)
EXPOSE 3000

# dumb-init as PID 1: forwards signals correctly so Node can do graceful shutdown.
# Default subcommand: serve.
# Override with command: ["node", "backend/dist/main.js", "worker|migrate"]
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "backend/dist/main.js", "serve"]
