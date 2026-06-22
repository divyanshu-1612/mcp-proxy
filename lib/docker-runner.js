// Manages MCP servers that run as sibling Docker containers via the host socket.
// Used for servers whose command starts with "docker run" (e.g. GitHub, SonarQube).
// All sibling containers are placed on the "mcp-daemon-net" network and labeled
// with "mcp-daemon.managed=true" for grouped lifecycle management.

const { spawn, execSync } = require('child_process');
const { log } = require('./log');

const CONTAINER_PREFIX = 'mcp-daemon-';
const NETWORK_NAME = 'mcp-daemon-net';
const LABEL = 'mcp-daemon.managed=true';
const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project=mcp-daemon';

class DockerRunner {
  constructor() {
    this.containers = new Map();
    this._ensureNetwork();
  }

  has(name) {
    return this.containers.has(name);
  }

  start(serverDef) {
    if (this.containers.has(serverDef.name)) {
      this.stop(serverDef.name);
    }

    const containerName = CONTAINER_PREFIX + serverDef.name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    this._removeStale(containerName);

    const dockerArgs = this._buildDockerArgs(serverDef, containerName);
    log(serverDef.name, `Starting container: docker ${dockerArgs.join(' ')}`);

    const child = spawn('docker', dockerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...serverDef.env },
    });

    const entry = {
      name: serverDef.name,
      def: serverDef,
      process: child,
      containerName,
      pid: child.pid,
      dead: false,
    };

    child.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) log(serverDef.name, msg, 'stderr');
    });

    child.on('error', (err) => {
      log(serverDef.name, `Container error: ${err.message}`, 'error');
      entry.dead = true;
    });

    child.on('exit', (code, signal) => {
      entry.dead = true;
      if (signal === 'SIGTERM' || signal === 'SIGKILL') {
        log(serverDef.name, `Container stopped (${signal})`);
      } else {
        log(serverDef.name, `Container exited (code=${code})`, 'warn');
      }
    });

    this.containers.set(serverDef.name, entry);
    log(serverDef.name, `Container started: ${containerName} (pid ${child.pid})`);
    return entry;
  }

  stop(name) {
    const entry = this.containers.get(name);
    if (!entry) return;

    if (!entry.dead) {
      try { entry.process.kill('SIGTERM'); } catch {}
    }

    try {
      execSync(`docker stop -t 5 ${entry.containerName} 2>/dev/null; docker rm -f ${entry.containerName} 2>/dev/null`, {
        stdio: 'ignore',
      });
    } catch {}

    this.containers.delete(name);
  }

  restart(serverDef) {
    this.stop(serverDef.name);
    setTimeout(() => this.start(serverDef), 1000);
  }

  stopAll() {
    for (const name of [...this.containers.keys()]) {
      this.stop(name);
    }
  }

  getProcess(name) {
    const entry = this.containers.get(name);
    if (!entry || entry.dead) return null;
    return entry;
  }

  status() {
    const result = {};
    for (const [name, entry] of this.containers) {
      result[name] = {
        type: 'docker',
        containerName: entry.containerName,
        pid: entry.pid,
        alive: !entry.dead,
      };
    }
    return result;
  }

  /**
   * Build docker run args from the server definition.
   * Injects: --name, --network, --label for grouping.
   */
  _buildDockerArgs(serverDef, containerName) {
    let args = [];

    if (serverDef.args && serverDef.args.length > 0) {
      args = [...serverDef.args];
    } else {
      const parts = serverDef.command.split(/\s+/);
      args = parts[0] === 'docker' ? parts.slice(1) : parts;
    }

    // Inject --name, --network, --label after "run"
    const runIdx = args.indexOf('run');
    if (runIdx !== -1) {
      const inject = [];
      if (!args.includes('--name')) inject.push('--name', containerName);
      if (!args.includes('--network')) inject.push('--network', NETWORK_NAME);
      inject.push('--label', LABEL);
      inject.push('--label', COMPOSE_PROJECT_LABEL);
      args.splice(runIdx + 1, 0, ...inject);
    }

    return args;
  }

  /** Ensure the shared Docker network exists */
  _ensureNetwork() {
    try {
      execSync(`docker network inspect ${NETWORK_NAME} 2>/dev/null`, { stdio: 'ignore' });
    } catch {
      try {
        execSync(`docker network create ${NETWORK_NAME}`, { stdio: 'ignore' });
        log('docker', `Created network: ${NETWORK_NAME}`);
      } catch (err) {
        log('docker', `Failed to create network: ${err.message}`, 'warn');
      }
    }
  }

  /** Remove a container by name if it exists (stale from previous run) */
  _removeStale(containerName) {
    try {
      execSync(`docker rm -f ${containerName} 2>/dev/null`, { stdio: 'ignore' });
    } catch {}
  }
}

module.exports = { DockerRunner };
