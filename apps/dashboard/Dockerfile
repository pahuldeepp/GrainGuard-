FROM node:20-alpine AS builder
WORKDIR /app
COPY apps/dashboard/package*.json ./
RUN npm ci || npm install
COPY apps/dashboard/ .
ARG VITE_AUTH0_DOMAIN
ARG VITE_AUTH0_CLIENT_ID
ARG VITE_AUTH0_AUDIENCE
ARG VITE_BFF_URL
ARG VITE_GATEWAY_URL
RUN npm run build

FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY apps/dashboard/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
