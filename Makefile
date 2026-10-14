# Common development tasks. `make help` lists them.

UV            ?= uv
DOCKER        ?= docker
COMPOSE       ?= $(DOCKER) compose
IMAGE         ?= managed-agents-server:dev
SANDBOX_IMAGE ?= agents-base:latest
HELM_CHART    ?= deploy/helm/managed-agents

.DEFAULT_GOAL := help
.PHONY: help install lint test test-live dev dev-docker down logs image sandbox-image openapi helm-lint e2b-template

help: ## Show this help
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z0-9_-]+:.*## / {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

install: ## Install the workspace and dev tools (uv sync)
	$(UV) sync

lint: ## Ruff lint
	$(UV) run ruff check .

test: ## Tests on recorded responses (uses TEST_DATABASE_URL or a local Postgres)
	$(UV) run pytest -q -m "not live"

test-live: ## Live tests against real model APIs (needs provider keys)
	$(UV) run pytest -q -m live

dev: ## Start the local stack (Postgres, MinIO, gateway, worker, scheduler)
	$(COMPOSE) up --build

dev-docker: sandbox-image ## Local stack with Docker sandboxes instead of E2B
	DOCKER_GID=$$(stat -c %g /var/run/docker.sock 2>/dev/null || stat -f %g /var/run/docker.sock) \
		$(COMPOSE) -f docker-compose.yml -f deploy/compose/docker-sandbox.yml up --build

down: ## Stop the local stack (keeps volumes; `make down V=1` removes them)
	$(COMPOSE) down $(if $(V),-v,)

logs: ## Follow logs of the local stack
	$(COMPOSE) logs -f

image: ## Build the server image
	$(DOCKER) build -t $(IMAGE) .

sandbox-image: ## Build the sandbox image (agents-base:latest) for the Docker provider
	$(DOCKER) build -t $(SANDBOX_IMAGE) infra/e2b

e2b-template: ## Build the agents-base E2B template (needs E2B_API_KEY)
	$(UV) run --no-project --with 'e2b>=2' python infra/e2b/build_template.py

openapi: ## Regenerate docs/api/openapi.json
	$(UV) run agents-server openapi > docs/api/openapi.json.tmp && mv docs/api/openapi.json.tmp docs/api/openapi.json

helm-lint: ## Lint and render the Helm chart with its CI values
	helm dependency build $(HELM_CHART)
	@for f in $(HELM_CHART)/ci/*.yaml; do \
		echo "== $$f"; \
		helm lint --strict $(HELM_CHART) -f $$f && helm template ci $(HELM_CHART) -f $$f > /dev/null || exit 1; \
	done
