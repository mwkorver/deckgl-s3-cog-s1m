# Developer task runner. `make` (or `make help`) lists targets.
#
# This is not the SAM build hook -- `sam build` uses app/Makefile and
# app/api/Makefile. This file is for humans running the project locally.

SHELL := /bin/bash
.DEFAULT_GOAL := help
PY ?= python3

# Dummy creds satisfy the DuckDB S3-secret setup in the Python tests; no test
# reads real S3. Mirrors the CI job.
TEST_ENV := AWS_ACCESS_KEY_ID=testing AWS_SECRET_ACCESS_KEY=testing AWS_DEFAULT_REGION=us-west-2

.PHONY: help run down logs install test test-js test-py lint fmt deps clean

help: ## List available targets
	@grep -hE '^[a-zA-Z0-9_-]+:.*?## ' $(MAKEFILE_LIST) \
	  | sort \
	  | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}'
	@echo
	@echo "First time: 'make run' (needs Docker). Imagery/search/terrain need AWS"
	@echo "credentials -- see the note it prints and app/README.md."

run: ## Build + serve the API and viewer in Docker -> http://localhost:8089/viewer/
	@test -f app/.env || { cp app/.env.example app/.env; \
	  echo ">> created app/.env from the example."; }
	@echo ">> The viewer and basemap load without AWS. Imagery, footprint search,"
	@echo ">> and terrain need AWS credentials in ~/.aws plus AWS_PROFILE in"
	@echo ">> app/.env (and a reachable lake -- see app/README.md 'Deploying to AWS')."
	cd app && docker compose up --build

down: ## Stop the local Docker stack
	cd app && docker compose down

logs: ## Follow the local API logs
	cd app && docker compose logs -f api

install: ## Fetch git submodules and build the TypeScript packages (for tests/dev)
	git submodule update --init --recursive
	pnpm install
	pnpm build

deps: ## Install Python dev + API dependencies (use a venv first)
	$(PY) -m pip install -r requirements-dev.txt -r app/api/requirements.txt

test: test-js test-py ## Run all tests (JS + Python)

test-js: ## TypeScript package tests (run `make install` first for the fixtures)
	pnpm -r test

test-py: ## Python API tests (`make deps` first; dummy AWS creds, no real S3)
	cd app/api && $(TEST_ENV) $(PY) -m pytest -q

lint: ## Biome (JS/TS) + Ruff (Python), read-only -- what CI runs
	pnpm exec biome ci .
	ruff check .
	ruff format --check .

fmt: ## Apply Biome + Ruff formatting
	pnpm exec biome check --write .
	ruff check --fix .
	ruff format .

clean: ## Remove build outputs and Python caches
	pnpm -r exec sh -c 'rm -rf dist *.tsbuildinfo' || true
	find . -name __pycache__ -type d -prune -not -path './node_modules/*' -exec rm -rf {} + 2>/dev/null || true
