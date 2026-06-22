# mcp-daemon

Single Docker container that manages all your Cursor MCP servers. Eliminates per-window process spawning — all Cursor windows share one set of servers.

## What it does

- Runs Docker-based MCP servers (GitHub, SonarQube) as sibling containers
- Runs npx-based MCP servers (Splunk, Jenkins) as child processes inside the daemon
- Exposes each server as `http://localhost:9800/mcp/<name>`
- Auto-restarts crashed servers
- Hot-reloads when you update tokens in the config

## Setup (one-time)

### 1. Backup your Cursor config

```bash
cp ~/.cursor/mcp.json ~/.mcp-daemon/data/servers.json
```

### 2. Replace Cursor config with proxy entries

Create a new `~/.cursor/mcp.json` that points managed servers at the daemon.
Keep URL-based servers (Atlassian, Celigo) as-is — they don't spawn processes.

```json
{
  "mcpServers": {
    "splunk-mcp-server": {
      "type": "http",
      "url": "http://127.0.0.1:9800/mcp/splunk-mcp-server"
    },
    "GitHub": {
      "type": "http",
      "url": "http://127.0.0.1:9800/mcp/GitHub"
    },
    "sonarqube": {
      "type": "http",
      "url": "http://127.0.0.1:9800/mcp/sonarqube"
    },
    "jenkins": {
      "type": "http",
      "url": "http://127.0.0.1:9800/mcp/jenkins"
    },
    "Atlassian-MCP-Server": {
      "url": "https://mcp.atlassian.com/v1/sse"
    },
    "CELIGO-MCP": {
      "type": "http",
      "url": "https://api.qa.staging.integrator.io/celigo-mcp",
      "headers": {
        "Authorization": "Bearer <your-token>"
      }
    }
  }
}
```

Rule: if the original entry has a `"command"` field, replace it with the proxy URL.
If it only has a `"url"` field, leave it unchanged.

### 3. Build and start

```bash
cd ~/.mcp-daemon
docker compose up -d --build
```

### 4. Restart Cursor

Close and reopen all Cursor windows to pick up the new config.

## Verify

```bash
make status   # shows server health
make ps       # lists all grouped containers
```

## Day-to-day

| Task | How |
|------|-----|
| Check health | `make status` or `curl localhost:9800/health` |
| View logs | `make logs` |
| Add a new MCP server | Add entry to `~/.mcp-daemon/data/servers.json` (auto-detected in ~2s) |
| Update a token | Edit `~/.mcp-daemon/data/servers.json` (auto-reloads affected server) |
| Restart everything | `make restart` |
| Stop everything | `make stop` |

## Undo

```bash
cd ~/.mcp-daemon
make stop
cp data/servers.json ~/.cursor/mcp.json
```

Then restart Cursor.

## Adding a new server

Just edit `~/.mcp-daemon/data/servers.json` and add the entry in standard Cursor mcp.json format:

```json
{
  "my-new-server": {
    "command": "npx",
    "args": ["-y", "some-mcp-server"],
    "env": { "API_KEY": "..." }
  }
}
```

The daemon detects the change automatically and spawns the new server.
Then add a matching proxy entry to `~/.cursor/mcp.json`:

```json
"my-new-server": {
  "type": "http",
  "url": "http://127.0.0.1:9800/mcp/my-new-server"
}
```

## File layout

```
~/.mcp-daemon/
├── Dockerfile
├── docker-compose.yml
├── Makefile
├── package.json
├── daemon.js               # Main entry
├── cli.js                  # Helper CLI (migrate/restore/status)
├── data/
│   └── servers.json        # YOUR server definitions (original mcp.json format)
└── lib/
    ├── log.js
    ├── lock.js
    ├── config.js
    ├── child-spawner.js    # Manages npx/node processes
    ├── docker-runner.js    # Manages sibling Docker containers
    └── stdio-bridge.js     # HTTP <-> stdio protocol bridge
```
