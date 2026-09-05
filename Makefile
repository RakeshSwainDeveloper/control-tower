# Control Tower — everything runs in Docker. There is no "install Postgres" path.
SHELL := /bin/bash
DC    := docker compose
.DEFAULT_GOAL := help

.PHONY: help up down restart reset build logs sh ps migrate migrate-status seed test test-iso lint typecheck fmt clean urls

help: ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | \
	  awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

env: ## Create .env from template if missing
	@test -f .env || (cp .env.example .env && echo "  created .env — review it")

up: env ## Build and start the whole stack, wait for health
	# --renew-anon-volumes re-seeds the node_modules volumes from the freshly
	# built image. Without it, a dependency change is built into the image but
	# the stale volume shadows it, and you debug a version mismatch that no
	# longer exists in any file you can see.
	#
	# --wait is scoped to the LONG-RUNNING services: `migrate` and `minio-init`
	# are one-shot jobs, and compose treats their clean exit as a wait failure.
	# They still run, pulled in as dependencies.
	$(DC) up -d --build --renew-anon-volumes --wait api web worker
	@$(MAKE) --no-print-directory urls

down: ## Stop everything, keep volumes
	$(DC) down --remove-orphans

restart: ## Restart a service:  make restart s=api
	$(DC) restart $(s)

reset: ## DESTRUCTIVE: stop, drop volumes, rebuild, re-migrate
	$(DC) down -v --remove-orphans
	$(DC) up -d --build --renew-anon-volumes --wait api web worker
	@$(MAKE) --no-print-directory urls

build: ## Rebuild images without starting
	$(DC) build

ps: ## Show service status
	$(DC) ps

logs: ## Follow logs:  make logs s=api   (omit s for all)
	$(DC) logs -f --tail=120 $(s)

sh: ## Shell into a service:  make sh s=api
	$(DC) exec $(s) sh

psql: ## Open psql on the app database
	$(DC) exec postgres psql -U postgres -d controltower

migrate: ## Apply pending migrations
	$(DC) run --rm migrate

migrate-status: ## Show migration status
	$(DC) exec api pnpm --filter @ct/api migrate:status

seed: ## Load the demo tenant
	$(DC) exec api pnpm --filter @ct/api seed

test: ## Run all tests inside Docker
	$(DC) exec api pnpm -r test

test-iso: ## Cross-tenant isolation suite only (CI gate)
	$(DC) exec api pnpm --filter @ct/api test -- isolation

typecheck: ## Typecheck every package (a real gate: 0 errors expected)
	$(DC) exec -T api sh -c "cd /app/apps/api && pnpm exec tsc -p tsconfig.json --noEmit"
	$(DC) exec -T api sh -c "cd /app/packages/contracts && pnpm exec tsc -p tsconfig.json --noEmit"

verify: ## Everything CI would run: typecheck + all tests
	@$(MAKE) --no-print-directory typecheck
	@$(MAKE) --no-print-directory test

lint: ## Lint every package
	$(DC) exec api pnpm -r lint

clean: ## Remove build artefacts (keeps volumes)
	rm -rf node_modules apps/*/node_modules packages/*/node_modules \
	       apps/*/dist packages/*/dist .turbo

urls:
	@echo ""
	@echo "  Control Tower is up:"
	@echo "    Web        http://localhost:5173"
	@echo "    API        http://localhost:3000/api/v1/health"
	@echo "    MinIO      http://localhost:9001   (console)"
	@echo "    Mailpit    http://localhost:8025"
	@echo "    Postgres   localhost:5432"
	@echo ""
