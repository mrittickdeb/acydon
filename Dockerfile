FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --production=false
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --production && npm cache clean --force
COPY --from=builder /app/dist ./dist
COPY dashboard/ ./dashboard/
COPY .env.example ./.env.example

RUN mkdir -p ./data

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -q --spider http://localhost:3000/api/health || exit 1

CMD ["node", "dist/index.js"]
