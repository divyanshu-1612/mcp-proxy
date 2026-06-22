// Bridges HTTP Streamable MCP transport to stdio child processes.
//
// MCP over stdio: newline-delimited JSON-RPC on stdin/stdout.
// MCP over HTTP Streamable: POST JSON-RPC body -> SSE response stream.
//
// For each HTTP request from Cursor, we forward JSON-RPC to the child's stdin
// and stream responses back as SSE events.

const { randomUUID } = require('crypto');
const { log } = require('./log');

class StdioBridge {
  constructor() {
    this.sessions = new Map();     // "serverName:sessionId" -> session
    this.attachedServers = new Set(); // track which server processes have a stdout listener
  }

  /**
   * Route an incoming HTTP request to the correct server's stdio.
   * @param {string} serverName
   * @param {object} processEntry - { process, name, ... } from ChildSpawner or DockerRunner
   * @param {IncomingMessage} req
   * @param {ServerResponse} res
   */
  async handle(serverName, processEntry, req, res) {
    if (!processEntry) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32603, message: `Server "${serverName}" is not running` },
        id: null,
      }));
      return;
    }

    switch (req.method) {
      case 'POST': return this._handlePost(serverName, processEntry, req, res);
      case 'GET':  return this._handleGet(serverName, processEntry, req, res);
      case 'DELETE': return this._handleDelete(serverName, req, res);
      default:
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method not allowed' }));
    }
  }

  // --- POST: Forward JSON-RPC request, stream response back as SSE ---

  async _handlePost(serverName, entry, req, res) {
    const body = await this._readBody(req);
    let message;
    try {
      message = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }));
      return;
    }

    let sessionId = req.headers['mcp-session-id'] || randomUUID();
    const session = this._getOrCreateSession(serverName, sessionId, entry);

    const messages = Array.isArray(message) ? message : [message];
    const requests = messages.filter(m => m.id !== undefined);

    // Write all messages to the server's stdin
    for (const msg of messages) {
      this._writeToStdio(entry, msg);
    }

    // Notifications only (no id) — respond 202 immediately
    if (requests.length === 0) {
      res.writeHead(202, { 'Mcp-Session-Id': sessionId });
      res.end();
      return;
    }

    // Requests — open SSE stream and wait for matching responses
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Mcp-Session-Id': sessionId,
    });

    const pendingIds = new Set(requests.map(r => r.id));

    const timeout = setTimeout(() => {
      cleanup();
      if (!res.writableEnded) res.end();
    }, 120000);

    const onResponse = (response) => {
      if (!pendingIds.has(response.id)) return;
      this._writeSseEvent(res, response, response.id);
      pendingIds.delete(response.id);
      if (pendingIds.size === 0) {
        cleanup();
        res.end();
      }
    };

    const cleanup = () => {
      clearTimeout(timeout);
      session.responseListeners.delete(onResponse);
    };

    session.responseListeners.add(onResponse);
    req.on('close', cleanup);
  }

  // --- GET: Open persistent SSE stream for server-initiated notifications ---

  _handleGet(serverName, entry, req, res) {
    const sessionId = req.headers['mcp-session-id'];
    if (!sessionId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing Mcp-Session-Id header' }));
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Mcp-Session-Id': sessionId,
    });

    const session = this._getOrCreateSession(serverName, sessionId, entry);
    session.sseConnections.add(res);
    req.on('close', () => session.sseConnections.delete(res));
  }

  // --- DELETE: Close a session ---

  _handleDelete(serverName, req, res) {
    const sessionId = req.headers['mcp-session-id'];
    if (sessionId) {
      const key = `${serverName}:${sessionId}`;
      const session = this.sessions.get(key);
      if (session) {
        for (const conn of session.sseConnections) conn.end();
        this.sessions.delete(key);
      }
    }
    res.writeHead(200);
    res.end();
  }

  // --- Internal helpers ---

  _getOrCreateSession(serverName, sessionId, entry) {
    const key = `${serverName}:${sessionId}`;
    if (this.sessions.has(key)) return this.sessions.get(key);

    const session = { id: sessionId, serverName, sseConnections: new Set(), responseListeners: new Set() };

    if (!this.attachedServers.has(serverName)) {
      this._attachStdioListener(serverName, entry);
      this.attachedServers.add(serverName);
    }

    this.sessions.set(key, session);
    return session;
  }

  _attachStdioListener(serverName, entry) {
    let buffer = '';
    entry.process.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete line

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed);
          this._dispatchMessage(serverName, msg);
        } catch {
          // Non-JSON output, ignore
        }
      }
    });
  }

  _dispatchMessage(serverName, message) {
    for (const [key, session] of this.sessions) {
      if (!key.startsWith(`${serverName}:`)) continue;

      // Response (has id) — dispatch to waiting request handlers
      if (message.id !== undefined) {
        for (const listener of session.responseListeners) listener(message);
      }

      // Server-initiated notification (method, no id) — push to SSE streams
      if (message.method && message.id === undefined) {
        for (const conn of session.sseConnections) this._writeSseEvent(conn, message);
      }
    }
  }

  _writeToStdio(entry, message) {
    try {
      entry.process.stdin.write(JSON.stringify(message) + '\n');
    } catch (err) {
      log(entry.name, `stdin write failed: ${err.message}`, 'error');
    }
  }

  _writeSseEvent(res, data, id) {
    try {
      if (id !== undefined) res.write(`id: ${id}\n`);
      res.write(`event: message\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {}
  }

  _readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks).toString()));
      req.on('error', reject);
    });
  }
}

module.exports = { StdioBridge };
