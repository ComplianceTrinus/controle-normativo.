FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    TZ=America/Sao_Paulo

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
 && npx playwright install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/* /root/.npm

COPY src ./src
COPY db ./db
COPY public ./public
COPY scripts ./scripts
COPY dados ./dados

RUN useradd --system --uid 10001 --home /app cn \
 && mkdir -p /app/uploads && chown -R cn /app/uploads
USER cn

ENV UPLOAD_DIR=/app/uploads PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://localhost:3000/saude').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
