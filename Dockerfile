# LAN Chat — image de production.
# Pensée pour Dokploy : Traefik termine le HTTPS (Let's Encrypt) et transmet en HTTP au conteneur.
# Base de données : PostgreSQL via DATABASE_URL (sinon SQLite dans /data, pratique pour un essai).
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    LANCHAT_HTTP=1

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server.js db.js ./
COPY public ./public

# /data contient les fichiers envoyés (chiffrés) — et la base SQLite si DATABASE_URL n'est pas définie.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
