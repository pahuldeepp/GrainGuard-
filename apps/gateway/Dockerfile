FROM node:20-alpine
WORKDIR /app
COPY apps/gateway/package*.json ./
RUN npm install
COPY apps/gateway/tsconfig.json ./
COPY apps/gateway/src ./src
COPY libs ./libs
RUN npx tsc
EXPOSE 3000
CMD ["node", "dist/server.js"]