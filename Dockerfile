# LAN Chat — image de production (aucune dépendance npm : seulement Node).
# Pensée pour Dokploy : Traefik termine le HTTPS (Let's Encrypt) et transmet en HTTP au conteneur.
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    LANCHAT_HTTP=1

WORKDIR /app
COPY package.json server.js ./
COPY public ./public

# Données persistantes (comptes, clés de canal chiffrées, messages chiffrés, fichiers) dans un volume,
# appartenant à l'utilisateur non-root « node ».
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
