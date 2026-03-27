FROM golang:1.25-alpine AS builder
WORKDIR /app

RUN apk add --no-cache ca-certificates

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
    -o /bin/saga-orchestrator \
    ./apps/saga-orchestrator/cmd

# --- runtime ---
FROM alpine:3.19
RUN apk add --no-cache ca-certificates

COPY --from=builder /bin/saga-orchestrator /saga-orchestrator

# 8081 = health check endpoints (/healthz/live, /healthz/ready)
EXPOSE 8081

ENTRYPOINT ["/saga-orchestrator"]