.PHONY: up down restart logs build seed test lint clean help

# ============================================
# GrainGuard — Developer Makefile
# ============================================

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

# ============================================
# Docker Compose
# ============================================

up: ## Start all services
	docker compose -f infra/docker/docker-compose.yml up -d

down: ## Stop all services
	docker compose -f infra/docker/docker-compose.yml down

restart: ## Restart all services
	docker compose -f infra/docker/docker-compose.yml restart

logs: ## Tail logs for all services
	docker compose -f infra/docker/docker-compose.yml logs -f

logs-gateway: ## Tail gateway logs
	docker compose -f infra/docker/docker-compose.yml logs -f gateway

logs-bff: ## Tail BFF logs
	docker compose -f infra/docker/docker-compose.yml logs -f bff

logs-kafka: ## Tail Kafka logs
	docker compose -f infra/docker/docker-compose.yml logs -f kafka

build: ## Build all Docker images
	docker compose -f infra/docker/docker-compose.yml build

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

test: ## Run all tests
	$(MAKE) test-go
	$(MAKE) test-react

test-go: ## Run Go tests
	go test ./...

test-react: ## Run React/Node tests
	cd apps/dashboard && npm test -- --run
	cd apps/bff && npm test -- --run

test-load: ## Run k6 load tests
	k6 run scripts/load-tests/gateway-load-test.js
	k6 run scripts/load-tests/bff-load-test.js

# ============================================
# Linting
# ============================================

lint: ## Lint all services
	$(MAKE) lint-go
	$(MAKE) lint-ts

lint-go: ## Lint Go services
	golangci-lint run ./...

lint-ts: ## Lint TypeScript services
	cd apps/gateway && npm run lint
	cd apps/bff && npm run lint
	cd apps/dashboard && npm run lint

# ============================================
# Cleanup
# ============================================

clean: ## Remove all containers and volumes
	docker compose -f infra/docker/docker-compose.yml down -v --remove-orphans

clean-cache: ## Clear Redis cache
	docker compose -f infra/docker/docker-compose.yml exec redis redis-cli FLUSHALL

# ============================================
# Status
# ============================================

ps: ## Show running services
	docker compose -f infra/docker/docker-compose.yml ps

health: ## Check health of all services
	curl -s http://localhost:8086/health | jq
	curl -s http://localhost:4000/health | jq