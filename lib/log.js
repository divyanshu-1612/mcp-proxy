// Structured logging with timestamps.

function timestamp() {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

function log(source, message, level = 'info') {
  const prefix = `[${timestamp()}] [${level.toUpperCase().padEnd(5)}] [${source}]`;
  if (level === 'error') {
    console.error(`${prefix} ${message}`);
  } else if (level === 'warn') {
    console.warn(`${prefix} ${message}`);
  } else {
    console.log(`${prefix} ${message}`);
  }
}

module.exports = { log };
