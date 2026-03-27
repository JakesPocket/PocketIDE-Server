const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const pty = require('node-pty');
const { spawn } = require('child_process');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

function resolveWorkspacePath() {
  if (process.env.WORKSPACE && fs.existsSync(process.env.WORKSPACE)) {
    return process.env.WORKSPACE;
  }

  const cwd = process.cwd();
  const siblingPocketIDE = path.resolve(cwd, '..', 'PocketIDE');
  if (fs.existsSync(siblingPocketIDE)) {
    return siblingPocketIDE;
  }

  if (fs.existsSync('/workspace')) {
    return '/workspace';
  }

  return process.cwd();
}

const WORKSPACE = resolveWorkspacePath();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// Change server CWD to workspace so the Copilot CLI subprocess inherits it,
// matching the same working environment as the node-pty bash shells.
try { process.chdir(WORKSPACE); } catch (_) {}

// =============================================================================
// Copilot Agent — initialised once at startup, session reused across requests
// =============================================================================

let copilotClient = null;
let agentSession = null;
let agentBusy = false; // guard against concurrent sends on the same session

async function createAgentSession() {
  if (!copilotClient) {
    throw new Error('Copilot client not initialised');
  }

  const { approveAll } = require('@github/copilot-sdk');

  if (agentSession) {
    try { await agentSession.disconnect(); } catch (_) {}
  }

  agentSession = await copilotClient.createSession({
    model: process.env.COPILOT_MODEL || 'gpt-5',
    streaming: true,
    onPermissionRequest: approveAll,
    systemMessage: {
      content:
        'You are an autonomous coding agent. You have permission to read/write files in /workspace and execute terminal commands to manage the repository.',
    },
  });

  console.log(`[copilot] agent session ready — ${agentSession.sessionId}`);
  return agentSession;
}

function shouldRecreateAgentSession(err) {
  const message = err?.message || '';
  return /session not found/i.test(message) || /unknown session/i.test(message);
}

async function streamAgentReply(session, prompt, sendEvent) {
  const unsubs = [];

  try {
    unsubs.push(
      session.on('assistant.reasoning_delta', (event) => {
        sendEvent({ type: 'reasoning', content: event.data.deltaContent });
      })
    );

    unsubs.push(
      session.on('assistant.message_delta', (event) => {
        sendEvent({ type: 'delta', content: event.data.deltaContent });
      })
    );

    unsubs.push(
      session.on('tool.execution_start', (event) => {
        sendEvent({
          type: 'tool_call',
          tool: event.data.toolName,
          input: event.data.toolInput ?? null,
        });
      })
    );

    unsubs.push(
      session.on('tool.execution_complete', (event) => {
        sendEvent({
          type: 'tool_result',
          tool: event.data.toolName,
          output: event.data.toolOutput ?? null,
        });
      })
    );

    unsubs.push(
      session.on('assistant.message', (event) => {
        sendEvent({ type: 'message', content: event.data.content });
      })
    );

    await new Promise((resolve, reject) => {
      unsubs.push(
        session.on('session.idle', () => resolve())
      );

      session.send({ prompt }).catch(reject);
    });
  } finally {
    unsubs.forEach((u) => u());
  }
}

async function initCopilotAgent() {
  try {
    const { CopilotClient, approveAll } = require('@github/copilot-sdk');

    copilotClient = new CopilotClient({
      // Picks up GITHUB_TOKEN / GH_TOKEN / COPILOT_GITHUB_TOKEN automatically;
      // explicit assignment gives it priority over cached CLI credentials.
      ...(process.env.GITHUB_TOKEN && { githubToken: process.env.GITHUB_TOKEN }),
    });

    await copilotClient.start();
    console.log('[copilot] client started');

    await createAgentSession();
  } catch (err) {
    console.warn('[copilot] SDK init failed — chat endpoint disabled:', err.message);
    copilotClient = null;
    agentSession = null;
  }
}

// =============================================================================
// Express & CORS
// =============================================================================

const app = express();

function isPrivateIp(hostname) {
  // Match common RFC1918 blocks used on local networks.
  return /^10\./.test(hostname) || /^192\.168\./.test(hostname) || /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname);
}

const isTrustedOrigin = (origin) => {
  if (!origin) return true;

  try {
    const { hostname } = new URL(origin);
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return true;
    if (hostname.endsWith('.app.github.dev')) return true;
    if (hostname.endsWith('.local')) return true;
    if (isPrivateIp(hostname)) return true;
    return false;
  } catch (_) {
    return false;
  }
};

const corsOptions = {
  origin: (origin, callback) =>
    isTrustedOrigin(origin)
      ? callback(null, true)
      : callback(new Error('Not allowed by CORS')),
  methods: ['GET', 'POST'],
  credentials: true,
};

app.use(cors(corsOptions));
app.use(express.json());

// =============================================================================
// POST /api/chat — Agent Mode with SSE streaming
//
// Response format: newline-delimited SSE events (text/event-stream).
// PWA should consume via fetch + ReadableStream.
//
// Event types streamed to client:
//   { type: "reasoning",   content: "..." }   — thinking / chain-of-thought delta
//   { type: "delta",       content: "..." }   — assistant text delta
//   { type: "tool_call",   tool: "...", input: {...} }   — agent tool invocation
//   { type: "tool_result", tool: "...", output: {...} }  — tool result
//   { type: "message",     content: "..." }   — final complete assistant message
//   { type: "error",       message: "..." }   — error during generation
//   { type: "done" }                          — stream complete
// =============================================================================

app.post('/api/chat', async (req, res) => {
  const { message } = req.body;

  if (!message) {
    return res.status(400).json({ error: 'Message is required' });
  }

  if (!agentSession) {
    return res.status(503).json({ error: 'Copilot agent not initialised. Check GITHUB_TOKEN.' });
  }

  if (agentBusy) {
    return res.status(429).json({ error: 'Agent is busy processing a previous request.' });
  }

  // --- Set up SSE streaming response ---
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendEvent = (payload) => {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    }
  };

  agentBusy = true;
  try {
    try {
      await streamAgentReply(agentSession, message, sendEvent);
    } catch (err) {
      if (!shouldRecreateAgentSession(err)) throw err;

      console.warn('[copilot] session invalid, recreating and retrying once');
      sendEvent({ type: 'tool_call', tool: 'copilot.session.reset', input: null });
      await createAgentSession();
      sendEvent({ type: 'tool_result', tool: 'copilot.session.reset', output: { ok: true, sessionId: agentSession.sessionId } });
      await streamAgentReply(agentSession, message, sendEvent);
    }

    sendEvent({ type: 'done' });
  } catch (err) {
    console.error('[copilot] chat error:', err);
    sendEvent({ type: 'error', message: err.message });
  } finally {
    agentBusy = false;
    res.end();
  }
});

// Reset the persistent agent session (new blank conversation)
app.post('/api/chat/reset', async (req, res) => {  if (!copilotClient) {
    return res.status(503).json({ error: 'Copilot client not available.' });
  }
  if (agentBusy) {
    return res.status(429).json({ error: 'Cannot reset while agent is busy.' });
  }
  try {
    await createAgentSession();
    console.log(`[copilot] session reset — ${agentSession.sessionId}`);
    res.json({ sessionId: agentSession.sessionId });
  } catch (err) {
    console.error('[copilot] reset error:', err);
    res.status(500).json({ error: err.message });
  }
});

// =============================================================================
// GET /api/files — return a recursive directory tree of WORKSPACE
// =============================================================================

function buildTree(dirPath, rootPath) {
  const name = path.basename(dirPath);
  const relPath = '/' + path.relative(rootPath, dirPath).replace(/\\/g, '/');
  let stat;
  try { stat = fs.statSync(dirPath); } catch { return null; }

  if (stat.isDirectory()) {
    // Skip hidden dirs and node_modules
    let children = [];
    let entries;
    try { entries = fs.readdirSync(dirPath); } catch { entries = []; }
    for (const entry of entries) {
      if (entry.startsWith('.') || entry === 'node_modules') continue;
      const child = buildTree(path.join(dirPath, entry), rootPath);
      if (child) children.push(child);
    }
    // Directories first, then files, both alphabetical
    children.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return { type: 'directory', name, path: relPath, children };
  }

  return { type: 'file', name, path: relPath };
}

app.get('/api/files', (req, res) => {
  const tree = buildTree(WORKSPACE, WORKSPACE);
  if (!tree) return res.status(404).json({ error: 'Workspace not found' });
  res.json(tree);
});

// =============================================================================
// GET /api/file?path=<relative> — return raw text content of a single file
// =============================================================================

app.get('/api/file', (req, res) => {
  const relPath = req.query.path;
  if (!relPath) return res.status(400).json({ error: 'path query param required' });

  // Prevent path traversal: resolve and verify it stays inside WORKSPACE
  const abs = path.resolve(WORKSPACE, relPath.replace(/^\//, ''));
  if (!abs.startsWith(path.resolve(WORKSPACE))) {
    return res.status(403).json({ error: 'Access denied' });
  }

  let stat;
  try { stat = fs.statSync(abs); } catch {
    return res.status(404).json({ error: 'File not found' });
  }
  if (!stat.isFile()) return res.status(400).json({ error: 'Not a file' });

  // Limit read to 1 MB to guard against accidentally opening huge binaries
  const MAX = 1024 * 1024;
  if (stat.size > MAX) {
    return res.status(413).json({ error: 'File too large to display (> 1 MB)' });
  }

  try {
    const content = fs.readFileSync(abs, 'utf8');
    res.type('text/plain').send(content);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    agent: agentSession ? 'ready' : 'unavailable',
    sessionId: agentSession?.sessionId ?? null,
  });
});

// =============================================================================
// HTTP server + Socket.io
// =============================================================================

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: (origin, callback) =>
      isTrustedOrigin(origin)
        ? callback(null, true)
        : callback(new Error('Not allowed by CORS')),
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

// =============================================================================
// Terminal — node-pty over Socket.io
// =============================================================================

const shells = new Map();

function resolveShellPath() {
  const candidates = [process.env.SHELL, '/bin/zsh', '/bin/bash', '/bin/sh'];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return '/bin/sh';
}

io.on('connection', (socket) => {
  console.log(`[terminal] client connected: ${socket.id}`);

  const shellPath = resolveShellPath();
  let shell;
  let isPty = false;

  try {
    shell = pty.spawn(shellPath, [], {
      name: 'xterm-color',
      cwd: WORKSPACE,
      env: { ...process.env, TERM: 'xterm-color' },
    });
    isPty = true;
  } catch (err) {
    console.error(`[terminal] failed to spawn shell for ${socket.id}:`, err.message);

    // Fallback for environments where node-pty cannot spawn (e.g. ABI/runtime issues).
    shell = spawn('/bin/sh', [], {
      cwd: WORKSPACE,
      env: { ...process.env, TERM: 'xterm-color' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    shell.on('error', (fallbackErr) => {
      console.error(`[terminal] fallback shell failed for ${socket.id}:`, fallbackErr.message);
      socket.emit('output', `Terminal unavailable: ${fallbackErr.message}\n`);
    });

    shell.stdout.on('data', (data) => socket.emit('output', data.toString()));
    shell.stderr.on('data', (data) => socket.emit('output', data.toString()));
    shell.on('exit', () => {
      socket.emit('exit');
      shells.delete(socket.id);
    });
  }

  shells.set(socket.id, shell);

  if (isPty) {
    shell.onData((data) => socket.emit('output', data.toString()));
    shell.onExit(() => {
      socket.emit('exit');
      shells.delete(socket.id);
    });
  }

  socket.on('input', (data) => {
    if (isPty) {
      if (shell.writable) shell.write(data);
      return;
    }

    if (shell.stdin?.writable) shell.stdin.write(data);
  });

  socket.on('resize', (cols, rows) => {
    if (!isPty) return;
    try { shell.resize(cols, rows); } catch (_) {}
  });

  socket.on('disconnect', () => {
    console.log(`[terminal] client disconnected: ${socket.id}`);
    try { shell.kill(); } catch (_) {}
    shells.delete(socket.id);
  });

  socket.on('error', (err) => {
    console.error(`[terminal] socket error ${socket.id}:`, err);
  });
});

// =============================================================================
// Graceful shutdown
// =============================================================================

async function shutdown() {
  console.log('[server] shutting down...');
  shells.forEach((shell) => { try { shell.kill(); } catch (_) {} });

  if (agentSession) {
    try { await agentSession.disconnect(); } catch (_) {}
  }
  if (copilotClient) {
    try { await copilotClient.stop(); } catch (_) {}
  }

  server.close(() => {
    console.log('[server] closed');
    process.exit(0);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// =============================================================================
// Boot
// =============================================================================

server.listen(PORT, HOST, async () => {
  console.log(`[server] PocketIDE Server listening on ${HOST}:${PORT}`);
  console.log(`[server] workspace: ${WORKSPACE}`);
  await initCopilotAgent();
});
