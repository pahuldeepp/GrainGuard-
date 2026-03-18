FROM node:22-alpine AS builder
WORKDIR /app
COPY apps/jobs-worker/package*.json ./
RUN npm install
COPY apps/jobs-worker/tsconfig.json ./
COPY apps/jobs-worker/src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
COPY apps/jobs-worker/package*.json ./
RUN npm install --production
COPY --from=builder /app/dist ./dist
USER node
CMD ["node", "dist/index.js"]
