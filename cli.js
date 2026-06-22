#!/usr/bin/env node

// CLI for mcp-daemon. Runs on the HOST (not inside Docker).
// Manages migration of Cursor config and daemon lifecycle via docker compose.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawn } = require('child_process');

const CURSOR_MCP_JSON = path.join(os.homedir(), '.cursor', 'mcp.json');
const DATA_DIR = path.join(os.homedir(), '.mcp-daemon', 'data');
const SERVERS_JSON = path.join(DATA_DIR, 'servers.json');
const DAEMON_DIR = path.join(os.homedir(), '.mcp-daemon');
const DAEMON_PORT = parseInt(process.env.MCP_DAEMON_PORT || '9800', 10);

const command = process.argv[2];
const commands = { migrate, restore, start, stop, status, logs, help };
const handler = commands[command];

if (!handler) {
  if (command) console.error(`Unknown command: ${command}\n`);
  help();
  process.exit(command ? 1 : 0);
}
handler();

// --- Commands ---

function migrate() {
  if (!fs.existsSync(CURSOR_MCP_JSON)) {
    console.error(`Cursor config not found: ${CURSOR_MCP_JSON}`);
    process.exit(1);
  }

  if (fs.existsSync(SERVERS_JSON)) {
    console.error(`Migration already done. Server definitions at: ${SERVERS_JSON}`);
    console.error('Run "mcp-daemon restore" first to undo previous migration.');
    process.exit(1);
  }

  // Copy original config to data/servers.json (what the daemon reads)
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const original = fs.readFileSync(CURSOR_MCP_JSON, 'utf8');
  fs.writeFileSync(SERVERS_JSON, original);
  console.log(`Original config saved to: ${SERVERS_JSON}`);

  // Rewrite Cursor's mcp.json to point managed servers at the daemon
  const config = JSON.parse(original);
  const servers = config.mcpServers || {};
  const cursorConfig = { mcpServers: {} };

  let managedCount = 0;
  let unmanagedCount = 0;

  for (const [name, def] of Object.entries(servers)) {
    if (def.command) {
      // Managed server (docker or child process) -> proxy through daemon
      cursorConfig.mcpServers[name] = {
        type: 'http',
        url: `http://127.0.0.1:${DAEMON_PORT}/mcp/${encodeURIComponent(name)}`,
      };
      managedCount++;
    } else {
      // URL-based server -> keep as-is
      cursorConfig.mcpServers[name] = def;
      unmanagedCount++;
    }
  }

  fs.writeFileSync(CURSOR_MCP_JSON, JSON.stringify(cursorConfig, null, 2));
  console.log(`\nMigrated ${CURSOR_MCP_JSON}:`);
  console.log(`  ${managedCount} server(s) -> proxied through daemon`);
  console.log(`  ${unmanagedCount} server(s) -> left as-is (URL-based)`);
  console.log(`\nNext steps:`);
  console.log(`  1. Start daemon: mcp-daemon start`);
  console.log(`  2. Restart Cursor`);
}

function restore() {
  if (!fs.existsSync(SERVERS_JSON)) {
    console.error('No backup found. Nothing to restore.');
    process.exit(1);
  }

  const original = fs.readFileSync(SERVERS_JSON, 'utf8');
  fs.writeFileSync(CURSOR_MCP_JSON, original);
  fs.unlinkSync(SERVERS_JSON);
  console.log(`Restored ${CURSOR_MCP_JSON} from backup.`);
  console.log('Restart Cursor to use the original config.');
}

function start() {
  console.log('Starting mcp-daemon via docker compose...');
  try {
    execSync('docker compose up -d --build', { cwd: DAEMON_DIR, stdio: 'inherit' });
    console.log('\nDaemon running. Check status: mcp-daemon status');
  } catch (err) {
    console.error('Failed to start. Is Docker running?');
    process.exit(1);
  }
}

function stop() {
  console.log('Stopping mcp-daemon...');
  try {
    execSync('docker compose down', { cwd: DAEMON_DIR, stdio: 'inherit' });
    console.log('Stopped.');
  } catch {
    console.error('Failed to stop (maybe already stopped).');
  }
}

function status() {
  // Check if container is running
  try {
    const out = execSync('docker inspect --format="{{.State.Status}}" mcp-daemon 2>/dev/null', {
      encoding: 'utf8',
    }).trim();
    console.log(`Container: ${out}`);
  } catch {
    console.log('Container: not running');
    return;
  }

  // Hit health endpoint
  const http = require('http');
  const req = http.get(`http://127.0.0.1:${DAEMON_PORT}/health`, (res) => {
    let data = '';
    res.on('data', c => data += c);
    res.on('end', () => {
      try {
        const info = JSON.parse(data);
        console.log('\nManaged servers:');
        for (const [name, s] of Object.entries(info.servers || {})) {
          const state = s.alive ? `alive (pid ${s.pid}, ${s.type})` : `dead (${s.type})`;
          console.log(`  ${name}: ${state}`);
        }
      } catch {
        console.log('  (could not parse health response)');
      }
    });
  });
  req.on('error', () => console.log('  (could not connect to daemon)'));
}

function logs() {
  try {
    execSync('docker compose logs -f --tail=50', { cwd: DAEMON_DIR, stdio: 'inherit' });
  } catch {}
}

function help() {
  console.log(`
mcp-daemon — Dockerized MCP server manager for Cursor

Usage:
  mcp-daemon <command>

Commands:
  migrate     Copy original config to ~/.mcp-daemon/data/servers.json,
              rewrite ~/.cursor/mcp.json to proxy through daemon
  restore     Undo migration, restore original ~/.cursor/mcp.json
  start       Start daemon container (docker compose up)
  stop        Stop daemon container (docker compose down)
  status      Show container and server health
  logs        Tail daemon container logs
  help        Show this help

Flow:
  1. mcp-daemon migrate   (one-time setup)
  2. mcp-daemon start     (starts Docker container)
  3. Restart Cursor       (picks up new config)

To update tokens:
  Edit ~/.mcp-daemon/data/servers.json — daemon auto-reloads affected servers.

To undo everything:
  mcp-daemon stop && mcp-daemon restore
`);
}
