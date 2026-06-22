// Spawns and manages non-Docker child processes (npx mcp-remote, etc).
// These run directly inside the daemon container as Node.js processes.

const { spawn } = require('child_process');
const { log } = require('./log');

const RESTART_DELAY_MS = 2000;
const MAX_RESTARTS = 5;
const RESTART_WINDOW_MS = 60000;

class ChildSpawner {
  constructor() {
    this.processes = new Map(); // name -> entry
  }

  has(name) {
    return this.processes.has(name);
  }

  start(serverDef) {
    if (this.processes.has(serverDef.name)) {
      this.stop(serverDef.name);
    }

    const env = { ...process.env, ...serverDef.env };
    const args = (serverDef.args || []).map(a => this._interpolateEnv(a, env));
    let command = this._interpolateEnv(serverDef.command, env);

    // Normalize absolute paths to known binaries (host paths don't exist in container)
    command = this._normalizeCommand(command);

    const useShell = args.length === 0 && command.includes(' ');

    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      shell: useShell,
    });

    const entry = {
      name: serverDef.name,
      def: serverDef,
      process: child,
      pid: child.pid,
      started: Date.now(),
      restartCount: 0,
      restartTimestamps: [],
      dead: false,
    };

    child.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) log(serverDef.name, msg, 'stderr');
    });

    child.on('error', (err) => {
      log(serverDef.name, `Process error: ${err.message}`, 'error');
      entry.dead = true;
      this._scheduleRestart(entry);
    });

    child.on('exit', (code, signal) => {
      entry.dead = true;
      if (signal === 'SIGTERM' || signal === 'SIGKILL') {
        log(serverDef.name, `Stopped (${signal})`);
        return;
      }
      log(serverDef.name, `Exited (code=${code}, signal=${signal}). Will restart...`, 'warn');
      this._scheduleRestart(entry);
    });

    this.processes.set(serverDef.name, entry);
    log(serverDef.name, `Spawned (pid ${child.pid})`);
    return entry;
  }

  stop(name) {
    const entry = this.processes.get(name);
    if (!entry) return;

    if (!entry.dead) {
      try {
        entry.process.kill('SIGTERM');
        setTimeout(() => { try { entry.process.kill('SIGKILL'); } catch {} }, 3000);
      } catch {}
    }
    this.processes.delete(name);
  }

  restart(serverDef) {
    this.stop(serverDef.name);
    setTimeout(() => this.start(serverDef), 500);
  }

  stopAll() {
    for (const name of [...this.processes.keys()]) {
      this.stop(name);
    }
  }

  getProcess(name) {
    const entry = this.processes.get(name);
    if (!entry || entry.dead) return null;
    return entry;
  }

  status() {
    const result = {};
    for (const [name, entry] of this.processes) {
      result[name] = {
        type: 'child',
        pid: entry.pid,
        alive: !entry.dead,
        restartCount: entry.restartCount,
        uptime: entry.dead ? 0 : Math.round((Date.now() - entry.started) / 1000),
      };
    }
    return result;
  }

  _scheduleRestart(entry) {
    const now = Date.now();
    entry.restartTimestamps = entry.restartTimestamps.filter(t => now - t < RESTART_WINDOW_MS);

    if (entry.restartTimestamps.length >= MAX_RESTARTS) {
      log(entry.name, `Too many restarts (${MAX_RESTARTS} in ${RESTART_WINDOW_MS / 1000}s). Giving up.`, 'error');
      return;
    }

    entry.restartTimestamps.push(now);
    entry.restartCount++;

    setTimeout(() => {
      if (!this.processes.has(entry.name)) return;
      if (this.processes.get(entry.name) !== entry) return;
      log(entry.name, `Restarting (attempt ${entry.restartCount})...`);
      this.start(entry.def);
    }, RESTART_DELAY_MS);
  }

  _interpolateEnv(str, env) {
    return str.replace(/\$\{([^}]+)\}/g, (_, key) => env[key] || '');
  }

  /** Strip absolute paths to known Node.js binaries — inside the container they're in PATH */
  _normalizeCommand(cmd) {
    const known = ['npx', 'node', 'npm'];
    for (const bin of known) {
      if (cmd.endsWith(`/${bin}`) || cmd.endsWith(`\\${bin}`)) return bin;
    }
    return cmd;
  }
}

module.exports = { ChildSpawner };
