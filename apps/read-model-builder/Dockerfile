FROM golang:1.25-alpine AS builder
WORKDIR /app

RUN apk add --no-cache ca-certificates

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
    -o /bin/read-model-builder \
    ./apps/read-model-builder/cmd

# --- runtime ---
FROM alpine:3.19
RUN apk add --no-cache ca-certificates

COPY --from=builder /bin/read-model-builder /read-model-builder

# 2112 = Prometheus metrics
# 8081 = health check endpoints (/healthz/live, /healthz/ready)
EXPOSE 2112 8081

ENTRYPOINT ["/read-model-builder"]