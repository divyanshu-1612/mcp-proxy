// PID-based lockfile for single-instance guarantee.

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.MCP_DATA_PATH || path.join(require('os').homedir(), '.mcp-daemon', 'data');
const LOCK_FILE = path.join(DATA_DIR, 'daemon.pid');

function isRunning(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function acquireLock() {
  if (fs.existsSync(LOCK_FILE)) {
    const existingPid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10);
    if (existingPid && isRunning(existingPid)) {
      return { acquired: false, pid: existingPid };
    }
    fs.unlinkSync(LOCK_FILE);
  }
  fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
  fs.writeFileSync(LOCK_FILE, String(process.pid));
  return { acquired: true, pid: process.pid };
}

function releaseLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10);
      if (pid === process.pid) fs.unlinkSync(LOCK_FILE);
    }
  } catch {}
}

function getRunningPid() {
  if (!fs.existsSync(LOCK_FILE)) return null;
  const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10);
  return (pid && isRunning(pid)) ? pid : null;
}

module.exports = { acquireLock, releaseLock, getRunningPid, LOCK_FILE };
