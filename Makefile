# Common development tasks. `make help` lists them.

UV            ?= uv
DOCKER        ?= docker
COMPOSE       ?= $(DOCKER) compose
IMAGE         ?= runhive-server:dev
SANDBOX_IMAGE ?= runhive-base:latest
HELM_CHART    ?= deploy/helm/runhive

.DEFAULT_GOAL := help
.PHONY: help install lint test test-live dev dev-docker down logs image sandbox-image openapi helm-lint k8s-manifests e2b-template e2b-check e2b-embed-up e2b-embed-env e2b-embed-down embed-stack-up embed-stack-down

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

sandbox-image: ## Build the sandbox image (runhive-base:latest) for the Docker provider
	$(DOCKER) build -t $(SANDBOX_IMAGE) infra/e2b

e2b-template: ## Build the runhive-base E2B template (needs E2B_API_KEY; E2B_API_URL for self-hosted)
	$(UV) run --no-project --with 'e2b>=2' python infra/e2b/build_template.py

k8s-manifests: ## Regenerate deploy/kubernetes/runhive-e2b-embed.yaml from the Helm chart (example values)
	{ cat deploy/kubernetes/header.txt; helm template runhive $(HELM_CHART) --namespace runhive \
	    -f $(HELM_CHART)/examples/e2b-embed-values.yaml; } > deploy/kubernetes/runhive-e2b-embed.yaml

e2b-check: ## Check the E2B setup end to end (E2B Cloud, or E2B_API_URL/E2B_SANDBOX_URL for self-hosted)
	$(UV) run runhive e2b check $(E2B_CHECK_ARGS)

# E2B Embed: the whole E2B runtime on this Linux host (needs KVM; see infra/e2b/README.md).
E2B_EMBED_REF ?= 50fc41af77ff0877d4224e5e4ded5e7f308b5476
# Shared with deploy/e2b-embed/up.sh, so both use the same Embed install.
E2B_EMBED_DIR ?= deploy/e2b-embed/embed

e2b-embed-up: ## Start a self-hosted E2B (E2B Embed, pinned to E2B_EMBED_REF) on this KVM host
	mkdir -p $(E2B_EMBED_DIR)
	cd $(E2B_EMBED_DIR) && curl -fsSL --remote-name-all "https://raw.githubusercontent.com/e2b-dev/runtime/$(E2B_EMBED_REF)/embed/compose/{compose.yaml,.env}"
	cd $(E2B_EMBED_DIR) && $(DOCKER) compose up -d --wait

e2b-embed-env: ## Print E2B Embed's SDK exports: eval "$$(make -s e2b-embed-env)"
	@cd $(E2B_EMBED_DIR) && $(DOCKER) compose exec -T ready cat /run/e2b/sdk.env

e2b-embed-down: ## Stop E2B Embed (keeps its data; add V=1 to remove it)
	cd $(E2B_EMBED_DIR) && $(DOCKER) compose down $(if $(V),-v,)

embed-stack-up: ## Runhive + E2B Embed on this KVM host: Embed, secrets, images, runhive-base, stack, check (deploy/e2b-embed)
	E2B_EMBED_REF=$(E2B_EMBED_REF) deploy/e2b-embed/up.sh $(ARGS)

embed-stack-down: ## Stop the Runhive + E2B Embed stack (ARGS=--embed also stops Embed, ARGS=--purge removes data)
	deploy/e2b-embed/down.sh $(ARGS)

openapi: ## Regenerate docs/api/openapi.json
	$(UV) run runhive-server openapi > docs/api/openapi.json.tmp && mv docs/api/openapi.json.tmp docs/api/openapi.json

helm-lint: ## Lint and render the Helm chart with its CI values
	helm dependency build $(HELM_CHART)
	@for f in $(HELM_CHART)/ci/*.yaml; do \
		echo "== $$f"; \
		helm lint --strict $(HELM_CHART) -f $$f && helm template ci $(HELM_CHART) -f $$f > /dev/null || exit 1; \
	done
