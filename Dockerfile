# --------- Build (TS) ----------
FROM node:20-alpine AS builder
WORKDIR /app
RUN apk add --no-cache curl
ENV CI=true
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --------- Runtime ------------
FROM node:20-alpine AS runtime
WORKDIR /app
RUN apk add --no-cache curl

# ne force PAS NODE_ENV ici: laisse Coolify le définir côté runtime
COPY package*.json ./
RUN npm ci --omit=dev

# ...
COPY --from=builder /app/dist ./dist
RUN mkdir -p /app/uploads && chown -R node:node /app/uploads
USER node
ENV PORT=5000
EXPOSE 5000
# ...


VOLUME ["/app/uploads"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||5000)+'/',r=>{if(r.statusCode<400)process.exit(0);process.exit(1)}).on('error',()=>process.exit(1))"

CMD ["node", "dist/index.js"]
