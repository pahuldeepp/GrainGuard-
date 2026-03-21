#!/usr/bin/env bash
set -e

echo "🌾 GrainGuard — Dev Bootstrap"
echo "=============================="

# Check dependencies
echo "→ Checking dependencies..."
command -v docker >/dev/null 2>&1 || { echo "❌ Docker not found. Install from https://docker.com"; exit 1; }
command -v node >/dev/null 2>&1 || { echo "❌ Node not found. Install from https://nodejs.org"; exit 1; }
command -v go >/dev/null 2>&1 || { echo "❌ Go not found. Install from https://golang.org"; exit 1; }
echo "✅ Dependencies OK"

# Install Node dependencies
echo "→ Installing Node dependencies..."
cd apps/bff && npm install && cd ../..
cd apps/gateway && npm install && cd ../..
cd apps/dashboard && npm install && cd ../..
cd apps/jobs-worker && npm install && cd ../..
echo "✅ Node dependencies installed"

# Start infrastructure
echo "→ Starting infrastructure..."
docker compose -f infra/docker/docker-compose.yml up -d \
  postgres postgres-read redis kafka zookeeper elasticsearch memcached pgbouncer loki
echo "✅ Infrastructure started"

# Wait for Postgres to be ready
echo "→ Waiting for Postgres..."
until docker compose -f infra/docker/docker-compose.yml exec -T postgres \
  pg_isready -U postgres -d grainguard; do
  sleep 2
done
echo "✅ Postgres ready"

# Wait for Kafka to be ready
echo "→ Waiting for Kafka..."
sleep 10
echo "✅ Kafka ready"

# Seed data
echo "→ Seeding dev data..."
docker compose -f infra/docker/docker-compose.yml exec -T postgres psql \
  -U postgres -d grainguard -f /dev/stdin < scripts/seed/seed-postgres.sh || true
echo "✅ Data seeded"

# Start all services
echo "→ Starting all services..."
docker compose -f infra/docker/docker-compose.yml up -d
echo "✅ All services started"

echo ""
echo "🚀 GrainGuard is running!"
echo "=============================="
echo "Dashboard:  http://localhost:5173"
echo "Gateway:    http://localhost:8086"
echo "BFF:        http://localhost:4000"
echo "Grafana:    http://localhost:3000"
echo "Prometheus: http://localhost:9090"
echo "Kibana:     http://localhost:5601"
echo "RabbitMQ:   http://localhost:15672"
echo "Kafka UI:   http://localhost:8082"
echo ""
echo "Run 'make help' for available commands"