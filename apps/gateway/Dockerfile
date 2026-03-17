# ---------- BUILDER ----------
FROM node:20-alpine AS builder

WORKDIR /app

COPY apps/gateway/package*.json ./
RUN npm install

COPY apps/gateway/tsconfig.json ./
COPY apps/gateway/src ./src
COPY libs ./libs

RUN npx tsc


# ---------- RUNTIME ----------
FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production

COPY apps/gateway/package*.json ./
RUN npm install --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/libs ./libs

EXPOSE 3000

CMD ["node","dist/server.js"]