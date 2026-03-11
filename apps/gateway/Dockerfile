# Stage 1: Build
FROM node:20-alpine AS builder
WORKDIR /app

COPY apps/gateway/package*.json ./
RUN npm install

COPY apps/gateway/tsconfig.json ./
COPY apps/gateway/src ./src
COPY libs ./libs
RUN npx tsc

# Stage 2: Production image
# Only compiled JS + production dependencies
FROM node:20-alpine
WORKDIR /app

COPY apps/gateway/package*.json ./
RUN npm install --production

COPY --from=builder /app/dist ./dist

EXPOSE 3000

CMD ["node", "dist/server.js"]