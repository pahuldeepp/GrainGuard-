FROM golang:1.24-alpine AS builder
WORKDIR /app

RUN apk add --no-cache ca-certificates

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
    -o /bin/telemetry-service \
    ./apps/telemetry-service/cmd

# --- runtime ---
FROM alpine:3.19
RUN apk add --no-cache ca-certificates

COPY --from=builder /bin/telemetry-service /telemetry-service

# 50051 = gRPC
# 8080  = HTTP (dev only)
# 8081  = health check endpoints (/healthz/live, /healthz/ready)
EXPOSE 50051 8080 8081

ENTRYPOINT ["/telemetry-service"]