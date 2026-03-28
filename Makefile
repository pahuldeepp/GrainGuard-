.PHONY: up down restart logs build seed test lint clean help ci

# ============================================
# GrainGuard — Developer Makefile
# ============================================

COMPOSE := docker compose -f infra/docker/docker-compose.yml

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

# ============================================
# Docker Compose
# ============================================

up: ## Start all services
	$(COMPOSE) up -d

down: ## Stop all services
	$(COMPOSE) down

restart: ## Restart all services
	$(COMPOSE) restart

logs: ## Tail logs for all services
	$(COMPOSE) logs -f

logs-gateway: ## Tail gateway logs
	$(COMPOSE) logs -f gateway

logs-bff: ## Tail BFF logs
	$(COMPOSE) logs -f bff

logs-kafka: ## Tail Kafka logs
	$(COMPOSE) logs -f kafka

logs-ingest: ## Tail ingest-service logs
	$(COMPOSE) logs -f ingest-service

build: ## Build all Docker images
	$(COMPOSE) build

# ============================================
# Database
# ============================================

seed: ## Seed dev data (Postgres + Elasticsearch)
	cd scripts/seed && bash seed-postgres.sh
	cd scripts/seed && bash seed-elasticsearch.sh

migrate: ## Run database migrations
	go run libs/migrate/migrate.go

# ============================================
# Testing
# ============================================

test: ## Run all tests (Go + TS)
	$(MAKE) test-go
	$(MAKE) test-gateway
	$(MAKE) test-dashboard

test-go: ## Run Go tests with race detector
	go test -race -count=1 ./...

test-gateway: ## Run Gateway unit tests
	cd apps/gateway && npx jest --passWithNoTests --forceExit

test-dashboard: ## Run Dashboard Vitest tests
	cd apps/dashboard && npx vitest run

test-e2e: ## Run Playwright E2E tests
	cd apps/dashboard && npx playwright test

test-load: ## Run k6 load tests
	k6 run scripts/load-tests/gateway-load-test.js
	k6 run scripts/load-tests/bff-load-test.js

# ============================================
# Linting
# ============================================

lint: ## Lint all services (Go + TS)
	$(MAKE) lint-go
	$(MAKE) lint-ts

lint-go: ## Lint Go services with golangci-lint
	golangci-lint run ./...

lint-ts: ## Lint all TypeScript services
	cd apps/gateway && npm run lint
	cd apps/bff && npm run lint
	cd apps/jobs-worker && npm run lint
	cd apps/dashboard && npm run lint

typecheck: ## Typecheck all TypeScript services
	cd apps/gateway && npm run typecheck
	cd apps/bff && npm run typecheck
	cd apps/dashboard && npm run build

lint-fix: ## Auto-fix lint issues
	golangci-lint run --fix ./...
	cd apps/gateway && npm run lint:fix
	cd apps/bff && npm run lint:fix
	cd apps/jobs-worker && npm run lint:fix
	cd apps/dashboard && npm run lint -- --fix

# ============================================
# CI (local mirror of GitHub Actions)
# ============================================

ci: ## Run full CI locally (lint + test + build)
	@echo "=== Go build ==="
	go build ./...
	@echo "=== Go vet ==="
	go vet ./...
	@echo "=== Go lint ==="
	command -v golangci-lint >/dev/null || { echo "Install: brew install golangci-lint"; exit 1; }
	golangci-lint run ./...
	@echo "=== Go test ==="
	go test -race -count=1 ./...
	@echo "=== TS lint ==="
	$(MAKE) lint-ts
	@echo "=== Gateway tests ==="
	$(MAKE) test-gateway
	@echo "=== Dashboard tests ==="
	$(MAKE) test-dashboard
	@echo "=== Dashboard build ==="
	cd apps/dashboard && npm run build
	@echo ""
	@echo "CI passed"

# ============================================
# Cleanup
# ============================================

clean: ## Remove all containers and volumes
	$(COMPOSE) down -v --remove-orphans

clean-cache: ## Clear Redis cache
	$(COMPOSE) exec redis redis-cli FLUSHALL

# ============================================
# Status
# ============================================

ps: ## Show running services
	$(COMPOSE) ps

health: ## Check health of all services
	@echo "=== Gateway ==="
	@curl -sf http://localhost:3000/health | jq . || echo "Gateway: DOWN"
	@echo "=== Gateway Readiness ==="
	@curl -sf http://localhost:3000/health/ready | jq . || echo "Gateway readiness: DOWN"
	@echo "=== BFF ==="
	@curl -sf http://localhost:4000/health | jq . || echo "BFF: DOWN"
	@echo "=== Ingest Service ==="
	@curl -sf http://localhost:3001/health | jq . || echo "Ingest: DOWN"
