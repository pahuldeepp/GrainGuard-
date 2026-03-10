# Stage 1: Build
# We use a separate build stage so the final image doesn't include
# TypeScript compiler, source files, or dev dependencies
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files first — Docker caches this layer
# If package.json hasn't changed, npm install is skipped on rebuild
COPY package*.json ./
RUN npm install

# Copy source and compile TypeScript → JavaScript
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Stage 2: Production image
# Only contains compiled JS + production dependencies
# Much smaller than including the full TypeScript toolchain
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --production

# Copy compiled output from builder stage
COPY --from=builder /app/dist ./dist

EXPOSE 4000

CMD ["node", "dist/server.js"]