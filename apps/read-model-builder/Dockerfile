FROM golang:1.22-alpine AS builder
WORKDIR /app


RUN apk add --no-cache ca-certificates

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /bin/read-model-builder ./cmd

# runtime stage
FROM alpine:3.19
RUN apk add --no-cache ca-certificates
COPY --from=builder /bin/read-model-builder /read-model-builder
EXPOSE 2112
ENTRYPOINT ["/read-model-builder"]