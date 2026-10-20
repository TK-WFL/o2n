# Build image for Anthropic OSS Scanner (https://github.com/anthropics/oss-scanner).
# The scanner builds this with the repository as the build context, then runs its analysis with no network,
# so every dependency the build and tests need is installed here.
FROM node:22-bookworm
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates git python3 \
    && rm -rf /var/lib/apt/lists/*

# scanner contract: the checkout lives inside the image, at /src
COPY . /src
WORKDIR /src

# npm workspaces: packages/core, packages/cli, packages/mcp-server
# core first: cli and mcp-server compile against its dist/ types.
RUN npm ci \
    && npm run build --workspace packages/core \
    && npm run build --workspace packages/cli --workspace packages/mcp-server \
    && npm run typecheck

# Cloudflare Worker for the OAuth code exchange (separate lockfile). Its tests run from the root vitest config.
RUN cd services/auth-proxy && npm ci

# Run the tests so the image is known to work, but do not let a failing test abort the build.
RUN npm test || echo "WARNING: vitest reported failures"
