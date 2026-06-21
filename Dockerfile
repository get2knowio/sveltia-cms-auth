# syntax=docker/dockerfile:1

# --- Build stage: install dev deps and bundle to a single JS file ---
FROM oven/bun:1.3.14-alpine AS build
WORKDIR /app

# Install dependencies against the lockfile for reproducible builds.
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile || bun install

# Bundle the app (no external runtime deps end up in the output).
COPY tsconfig.json ./
COPY src ./src
RUN bun build ./src/index.ts --target=bun --minify --outfile=dist/index.js

# --- Runtime stage: minimal, non-root ---
FROM oven/bun:1.3.14-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0

# Copy only the bundled output. `bun` (uid 1000) is provided by the base image.
COPY --from=build /app/dist ./dist

USER bun
EXPOSE 3000

CMD ["bun", "run", "dist/index.js"]
