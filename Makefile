.DEFAULT_GOAL := help

LABEL := mcp-daemon.managed=true

.PHONY: help migrate restore start stop restart status logs build clean ps

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

migrate: ## Copy original mcp.json to data/servers.json, rewrite Cursor config
	@node cli.js migrate

restore: ## Undo migration, restore original ~/.cursor/mcp.json
	@node cli.js restore

start: ## Build and start daemon container
	@docker compose up -d --build

stop: ## Stop daemon and ALL managed containers (labeled mcp-daemon.managed)
	@docker ps -q --filter "label=$(LABEL)" | xargs -r docker stop -t 5 2>/dev/null || true
	@docker ps -aq --filter "label=$(LABEL)" | xargs -r docker rm -f 2>/dev/null || true
	@docker compose down 2>/dev/null || true

restart: stop start ## Rebuild and restart everything

status: ## Show container and server health
	@node cli.js status

ps: ## List all managed containers (daemon + siblings)
	@docker ps --filter "label=$(LABEL)" --format "table {{.Names}}\t{{.Status}}\t{{.Image}}"

logs: ## Tail daemon container logs
	@docker compose logs -f --tail=50

build: ## Build the Docker image without starting
	@docker compose build

clean: stop ## Stop everything, remove image and network
	@docker rmi mcp-daemon-mcp-daemon 2>/dev/null || true
	@docker network rm mcp-daemon-net 2>/dev/null || true
	@echo "Cleaned."
