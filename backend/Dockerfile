# UWS AI Sales Calling Agent — backend image.
#
# Build from the REPO ROOT (the SPA lives in a sibling folder):
#
#   docker build -f backend/Dockerfile -t uws-ai-agent .
#   docker run -p 3100:3100 -v uws-data:/app/data --env-file backend/.env uws-ai-agent
#
# Node 24 runs the TypeScript sources directly (type stripping), so there is
# no build/transpile step: install, copy, run. Usable by any container host.
#
# Runtime contract:
#   - listens on PORT (config default 3100; hosts inject PORT, e.g. 8080)
#   - persists SQLite at DATABASE_PATH (default ./data/uws.sqlite) — mount a
#     volume there in production, otherwise data is lost on redeploy
#   - configuration comes from environment variables (no .env required)
#   - health: GET /api/health

FROM node:24-slim

ENV NODE_ENV=production \
    PORT=3100 \
    DATABASE_PATH=/app/data/uws.sqlite

WORKDIR /app

# Dependencies first for layer caching; the lockfile is committed.
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev

# Application sources. `frontend` lands at /frontend because WEB_ROOT is
# resolved as <server dir>/../../../frontend (see backend/src/server/app.ts).
COPY backend/src ./src
COPY frontend ../frontend

# Database + backups live in a mountable volume, not in the code layers.
RUN mkdir -p /app/data/backups
VOLUME ["/app/data"]

EXPOSE 3100

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3100)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD node --disable-warning=ExperimentalWarning --env-file-if-exists=.env src/cli/setup.ts && exec node --disable-warning=ExperimentalWarning --env-file-if-exists=.env src/server/index.ts
