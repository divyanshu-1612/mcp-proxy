// Reads MCP server definitions from a JSON config file.
// Classifies each server as "docker" (docker run ...) or "child" (npx, node, etc.)
// or "url" (remote HTTP/SSE — not managed by daemon).

const fs = require('fs');
const path = require('path');
const os = require('os');
const { log } = require('./log');

const CURSOR_MCP_JSON = path.join(os.homedir(), '.cursor', 'mcp.json');
const DATA_DIR = process.env.MCP_DATA_PATH || path.join(os.homedir(), '.mcp-daemon', 'data');
const SERVERS_JSON = path.join(DATA_DIR, 'servers.json');
const DAEMON_PORT = parseInt(process.env.MCP_DAEMON_PORT || '9800', 10);

/** Where we read server definitions from (inside container or on host) */
function getConfigPath() {
  if (process.env.MCP_CONFIG_PATH && fs.existsSync(process.env.MCP_CONFIG_PATH)) {
    return process.env.MCP_CONFIG_PATH;
  }
  if (fs.existsSync(SERVERS_JSON)) return SERVERS_JSON;
  return CURSOR_MCP_JSON;
}

function readRawConfig(filePath) {
  return JSON.parse(fs.readFileSync(filePath || getConfigPath(), 'utf8'));
}

/**
 * Classify a server definition into one of:
 *   - "docker": command contains/starts with "docker"
 *   - "child": has a command but not docker (npx, node, etc.)
 *   - "url": only has a url (remote HTTP/SSE, not managed)
 */
function classifyServer(name, def) {
  if (def.command) {
    const isDocker = def.command.startsWith('docker') ||
      (def.command === 'docker') ||
      (def.args && def.args[0] === 'run');

    return {
      name,
      type: isDocker ? 'docker' : 'child',
      command: def.command,
      args: def.args || [],
      env: def.env || {},
      _raw: def,
    };
  }

  if (def.url) {
    return {
      name,
      type: 'url',
      url: def.url,
      headers: def.headers || {},
      _raw: def,
    };
  }

  return { name, type: 'unknown', _raw: def };
}

function loadConfig(filePath) {
  const raw = readRawConfig(filePath);
  const servers = raw.mcpServers || {};
  return Object.entries(servers).map(([name, def]) => classifyServer(name, def));
}

/** Generate the Cursor-facing mcp.json (proxied stdio servers, untouched url servers) */
function generateCursorConfig(servers) {
  const mcpServers = {};
  for (const server of servers) {
    if (server.type === 'docker' || server.type === 'child') {
      mcpServers[server.name] = {
        type: 'http',
        url: `http://127.0.0.1:${DAEMON_PORT}/mcp/${encodeURIComponent(server.name)}`,
      };
    } else {
      mcpServers[server.name] = server._raw;
    }
  }
  return { mcpServers };
}

// --- Config watching ---

function computeFingerprint(serverDef) {
  const { _raw, ...rest } = serverDef;
  return JSON.stringify(rest);
}

let watcher = null;
let previousFingerprints = new Map();

function watchConfig(onChange) {
  const configPath = getConfigPath();
  log('config', `Watching ${configPath} for changes`);

  const servers = loadConfig(configPath);
  previousFingerprints = new Map(servers.map(s => [s.name, computeFingerprint(s)]));

  let debounceTimer = null;
  const chokidar = require('chokidar');
  watcher = chokidar.watch(configPath, { ignoreInitial: true, usePolling: true, interval: 2000 });

  watcher.on('change', () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      try {
        const newServers = loadConfig(configPath);
        const newFingerprints = new Map(newServers.map(s => [s.name, computeFingerprint(s)]));
        const changedNames = [];

        for (const [name, fp] of newFingerprints) {
          if (previousFingerprints.get(name) !== fp) changedNames.push(name);
        }
        for (const name of previousFingerprints.keys()) {
          if (!newFingerprints.has(name)) changedNames.push(name);
        }

        if (changedNames.length > 0) {
          previousFingerprints = newFingerprints;
          onChange(newServers, changedNames);
        }
      } catch (err) {
        log('config', `Error reloading: ${err.message}`, 'error');
      }
    }, 500);
  });
}

function stopWatching() {
  if (watcher) watcher.close();
}

module.exports = {
  CURSOR_MCP_JSON,
  SERVERS_JSON,
  DATA_DIR,
  DAEMON_PORT,
  getConfigPath,
  loadConfig,
  generateCursorConfig,
  watchConfig,
  stopWatching,
};
