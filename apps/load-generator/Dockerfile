FROM golang:1.25-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN go build -o load-generator ./apps/load-generator/main.go

FROM alpine:3.19
WORKDIR /app
COPY --from=builder /app/load-generator .
CMD ["./load-generator"]
