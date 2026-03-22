FROM golang:1.25-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN go build -o asset-registry ./apps/asset-registry/cmd/main.go

FROM alpine:3.19
WORKDIR /app
COPY --from=builder /app/asset-registry .
CMD ["./asset-registry"]
