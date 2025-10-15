# ----------- 1) Build (TypeScript) -----------
FROM node:20-alpine AS builder
WORKDIR /app

# Évite les prompts et accélère npm
ENV CI=true
# Copie les manifests en premier pour maximiser le cache
COPY package*.json ./
# Installe toutes les deps (dev incluses pour compiler TS)
RUN npm ci

# Copie le reste du code
COPY tsconfig.json ./
COPY src ./src

# Compile TypeScript -> dist
RUN npm run build

# ----------- 2) Runtime minimal -----------
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=development

# Copie uniquement ce qui est nécessaire pour run en prod
COPY package*.json ./
RUN npm ci --omit=dev

# Copie le build et crée le dossier d’uploads
COPY --from=builder /app/dist ./dist
# (si tu as des fichiers seed/fixtures statiques à servir, ajoute-les ici)
RUN mkdir -p /app/uploads

# Sécurité : utilisateur non-root
RUN addgroup -S nodejs && adduser -S node -G nodejs
USER node

# Le port exposé dans le conteneur (Coolify écoute dessus)
ENV PORT=5000
EXPOSE 5000

# Déclare un volume pour persister les fichiers uploadés
VOLUME ["/app/uploads"]

# (Optionnel) Healthcheck simple sur /health s'il existe
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/health',r=>{if(r.statusCode<400)process.exit(0);process.exit(1)}).on('error',()=>process.exit(1))"

# Commande de démarrage
CMD ["node", "dist/index.js"]
