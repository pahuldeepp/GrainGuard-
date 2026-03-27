FROM node:20-alpine
WORKDIR /app
COPY apps/workflow-alerts/package.json .
RUN npm install
COPY apps/workflow-alerts/tsconfig.json .
COPY apps/workflow-alerts/src/ src/
RUN npm run build
CMD ["node", "dist/index.js"]
