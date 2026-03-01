FROM golang:1.22-alpine AS builder
WORKDIR /app

RUN apk add --no-cache ca-certificates

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
    -o /bin/dlq-reprocessor \
    ./apps/dlq-reprocessor/cmd

# --- runtime ---
FROM alpine:3.19
RUN apk add --no-cache ca-certificates

COPY --from=builder /bin/dlq-reprocessor /dlq-reprocessor

ENTRYPOINT ["/dlq-reprocessor"]
