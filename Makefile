.DEFAULT_GOAL := help

LABEL := mcp-daemon.managed=true
DAEMON_PORT ?= 9800
SERVERS_JSON := $(HOME)/.mcp-daemon/data/servers.json
CURSOR_MCP := $(HOME)/.cursor/mcp.json

.PHONY: help setup migrate restore start stop restart status ps logs build clean add health

help: ## Show all available commands
	@echo ""
	@echo "  mcp-daemon — Dockerized MCP server manager for Cursor"
	@echo ""
	@echo "  Quick start:  make setup    (first time)"
	@echo "  Daily use:    make start / make stop / make status"
	@echo "  Add server:   make add NAME=my-server CMD='npx -y some-mcp-server' ENV='API_KEY=xxx'"
	@echo ""
	@echo "  Commands:"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "    \033[36m%-14s\033[0m %s\n", $$1, $$2}'
	@echo ""

# --- First-time setup ---

setup: migrate start ## One-command first-time setup (migrate config + start daemon)
	@echo ""
	@echo "  ✓ Done. Restart Cursor to connect through the daemon."
	@echo "  Run 'make status' to verify servers are alive."

migrate: ## Copy ~/.cursor/mcp.json to daemon config, rewrite Cursor to use proxy
	@node cli.js migrate

restore: ## Undo migration, restore original ~/.cursor/mcp.json
	@node cli.js restore

# --- Lifecycle ---

start: ## Start the daemon container
	@docker compose up -d --build

stop: ## Stop daemon and all managed containers
	@docker ps -q --filter "label=$(LABEL)" | xargs -r docker stop -t 5 2>/dev/null || true
	@docker ps -aq --filter "label=$(LABEL)" | xargs -r docker rm -f 2>/dev/null || true
	@docker compose down 2>/dev/null || true

restart: stop start ## Rebuild and restart everything

# --- Observability ---

status: ## Show container state and server health
	@node cli.js status

health: ## Quick health check (curl the daemon)
	@curl -sf http://127.0.0.1:$(DAEMON_PORT)/health | python3 -m json.tool 2>/dev/null \
		|| echo "Daemon not reachable at port $(DAEMON_PORT)"

ps: ## List all managed containers
	@docker ps --filter "label=$(LABEL)" --format "table {{.Names}}\t{{.Status}}\t{{.Image}}\t{{.Ports}}"

logs: ## Tail daemon logs
	@docker compose logs -f --tail=50

# --- Server management ---

add: ## Add an MCP server. Usage: make add NAME=foo CMD='npx -y pkg' ENV='KEY=val,KEY2=val2'
	@if [ -z "$(NAME)" ]; then echo "Error: NAME is required. Example:"; echo "  make add NAME=my-server CMD='npx -y some-mcp-server' ENV='API_KEY=xxx'"; exit 1; fi
	@if [ ! -f $(SERVERS_JSON) ]; then echo "Error: Run 'make setup' first."; exit 1; fi
	@node -e '\
		const fs = require("fs"); \
		const f = "$(SERVERS_JSON)"; \
		const cfg = JSON.parse(fs.readFileSync(f, "utf8")); \
		const name = "$(NAME)"; \
		if (cfg.mcpServers[name]) { console.error("Server \"" + name + "\" already exists."); process.exit(1); } \
		const entry = {}; \
		const cmd = "$(CMD)"; \
		if (cmd) { \
			const parts = cmd.split(/\s+/); \
			entry.command = parts[0]; \
			entry.args = parts.slice(1); \
		} \
		const envStr = "$(ENV)"; \
		if (envStr) { \
			entry.env = {}; \
			envStr.split(",").forEach(function(kv) { \
				const idx = kv.indexOf("="); \
				if (idx > 0) entry.env[kv.slice(0, idx)] = kv.slice(idx + 1); \
			}); \
		} \
		cfg.mcpServers[name] = entry; \
		fs.writeFileSync(f, JSON.stringify(cfg, null, 2)); \
		console.log("Added \"" + name + "\" to " + f); \
		console.log("Daemon will auto-detect in ~2s."); \
		const cursorFile = "$(CURSOR_MCP)"; \
		const cursorCfg = JSON.parse(fs.readFileSync(cursorFile, "utf8")); \
		cursorCfg.mcpServers[name] = { type: "http", url: "http://127.0.0.1:$(DAEMON_PORT)/mcp/" + encodeURIComponent(name) }; \
		fs.writeFileSync(cursorFile, JSON.stringify(cursorCfg, null, 2)); \
		console.log("Added proxy entry to " + cursorFile); \
		console.log("Restart Cursor to pick up the new server."); \
	'

# --- Cleanup ---

build: ## Build Docker image without starting
	@docker compose build

clean: stop ## Stop everything, remove images and network
	@docker rmi mcp-daemon-mcp-daemon 2>/dev/null || true
	@docker network rm mcp-daemon-net 2>/dev/null || true
	@echo "Cleaned."
