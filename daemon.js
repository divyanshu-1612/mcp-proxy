// MCP Daemon — single-process manager for all stdio-based MCP servers.
// Runs inside Docker (or standalone). Exposes each server as an HTTP endpoint.

const http = require('http');
const { acquireLock, releaseLock } = require('./lib/lock');
const { loadConfig, watchConfig, DAEMON_PORT } = require('./lib/config');
const { ChildSpawner } = require('./lib/child-spawner');
const { DockerRunner } = require('./lib/docker-runner');
const { StdioBridge } = require('./lib/stdio-bridge');
const { log } = require('./lib/log');

const HOST = '0.0.0.0'; // bind all interfaces (needed inside Docker)

let childSpawner;
let dockerRunner;
let stdioBridge;

async function main() {
  const lock = acquireLock();
  if (!lock.acquired) {
    log('daemon', `Already running (pid ${lock.pid}). Exiting.`, 'error');
    process.exit(1);
  }

  log('daemon', `Starting (pid ${process.pid})`);

  // Load server definitions
  const servers = loadConfig();
  const dockerServers = servers.filter(s => s.type === 'docker');
  const childServers = servers.filter(s => s.type === 'child');
  const urlServers = servers.filter(s => s.type === 'url');

  log('daemon', `Servers: ${dockerServers.length} docker, ${childServers.length} child, ${urlServers.length} url (unmanaged)`);

  // Initialize managers
  childSpawner = new ChildSpawner();
  dockerRunner = new DockerRunner();
  stdioBridge = new StdioBridge();

  // Start all managed servers
  for (const s of dockerServers) dockerRunner.start(s);
  for (const s of childServers) childSpawner.start(s);

  // HTTP server
  const httpServer = http.createServer(handleRequest);
  httpServer.listen(DAEMON_PORT, HOST, () => {
    log('daemon', `Listening on http://${HOST}:${DAEMON_PORT}`);
    log('daemon', 'Endpoints:');
    [...dockerServers, ...childServers].forEach(s => {
      log('daemon', `  /mcp/${encodeURIComponent(s.name)} [${s.type}]`);
    });
  });

  // Watch for config changes (token updates, new servers, etc.)
  watchConfig((newServers, changedNames) => {
    log('daemon', `Config changed: ${changedNames.join(', ')}`);
    for (const name of changedNames) {
      const serverDef = newServers.find(s => s.name === name);
      if (!serverDef) {
        // Server removed
        childSpawner.stop(name);
        dockerRunner.stop(name);
        continue;
      }
      if (serverDef.type === 'docker') {
        dockerRunner.restart(serverDef);
      } else if (serverDef.type === 'child') {
        childSpawner.restart(serverDef);
      }
    }
    // Detect newly added servers
    for (const s of newServers) {
      if (s.type === 'url') continue;
      if (changedNames.includes(s.name)) continue;
      if (childSpawner.has(s.name) || dockerRunner.has(s.name)) continue;
      log('daemon', `New server: ${s.name} [${s.type}]`);
      if (s.type === 'docker') dockerRunner.start(s);
      else childSpawner.start(s);
    }
  });

  // Graceful shutdown
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.on('exit', releaseLock);
}

function handleRequest(req, res) {
  // Health endpoint
  if (req.method === 'GET' && req.url === '/health') {
    const status = { ...childSpawner.status(), ...dockerRunner.status() };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', servers: status }));
    return;
  }

  // MCP endpoint: /mcp/<serverName>[/...]
  const match = req.url.match(/^\/mcp\/([^/]+)(\/.*)?$/);
  if (!match) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found. Use /mcp/<serverName> or /health' }));
    return;
  }

  const serverName = decodeURIComponent(match[1]);
  const processEntry = childSpawner.getProcess(serverName) || dockerRunner.getProcess(serverName);
  stdioBridge.handle(serverName, processEntry, req, res);
}

function shutdown() {
  log('daemon', 'Shutting down...');
  childSpawner.stopAll();
  dockerRunner.stopAll();
  releaseLock();
  process.exit(0);
}

main().catch(err => {
  log('daemon', `Fatal: ${err.message}`, 'error');
  releaseLock();
  process.exit(1);
});
