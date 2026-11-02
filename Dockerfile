FROM node:24-slim

ENV NODE_ENV=production 
PORT=3100 
DATABASE_PATH=/app/data/uws.sqlite

WORKDIR /app

COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev

COPY backend/src ./src
COPY frontend ../frontend

RUN mkdir -p /app/data/backups
VOLUME ["/app/data"]

EXPOSE 3100

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 
CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3100)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--disable-warning=ExperimentalWarning", "src/server/index.ts"]