# Stage 1: Build
FROM node:22-alpine AS builder

WORKDIR /app

COPY apps/bff/package*.json ./
RUN npm install

COPY apps/bff/tsconfig.json ./
COPY apps/bff/src ./src
RUN npm run build

# Stage 2: Production image
FROM node:22-alpine

WORKDIR /app

COPY apps/bff/package*.json ./
RUN npm install --production

COPY --from=builder /app/dist ./dist

EXPOSE 4000

CMD ["node", "dist/server.js"]