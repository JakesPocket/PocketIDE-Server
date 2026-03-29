const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const pty = require('node-pty');
const { spawn } = require('child_process');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const os = require('os');

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

let WORKSPACE = resolveWorkspacePath();

// In-memory snapshot of file contents captured at each "Keep" action.
// Maps workspace-relative path → file content string.
const keepSnapshots = new Map();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const TWO_MINUTES_MS = 2 * 60 * 1000;
const TOOL_STEP_TIMEOUT_MS = 45 * 1000;
const MAX_CONSECUTIVE_IDENTICAL_STEPS = 8;
const MAX_TOOL_EXECUTIONS_PER_SIGNATURE = 14;

// Change server CWD to workspace so the Copilot CLI subprocess inherits it,
// matching the same working environment as the node-pty bash shells.
try { process.chdir(WORKSPACE); } catch (_) {}

// =============================================================================
// Copilot Agent — initialised once at startup, session reused across requests
// =============================================================================

let copilotClient = null;
let agentSession = null;
let agentBusy = false; // guard against concurrent sends on the same session
let activeCopilotAuthMode = 'unknown';

function resolveGithubToken() {
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.COPILOT_GITHUB_TOKEN || null;
}

function resolveCopilotAuthConfig() {
  const mode = String(process.env.COPILOT_AUTH_MODE || 'logged-in-user').trim().toLowerCase();
  const token = resolveGithubToken();

  if (mode === 'token') {
    if (!token) {
      throw new Error('COPILOT_AUTH_MODE=token requires GITHUB_TOKEN (or GH_TOKEN/COPILOT_GITHUB_TOKEN).');
    }
    return { mode: 'token', config: { githubToken: token } };
  }

  if (mode === 'auto') {
    if (token) {
      return { mode: 'token', config: { githubToken: token } };
    }
    return { mode: 'logged-in-user', config: { useLoggedInUser: true } };
  }

  // Default is logged-in-user to better match VS Code Copilot Chat behavior.
  return { mode: 'logged-in-user', config: { useLoggedInUser: true } };
}

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

async function streamAgentReply(session, prompt, sendEvent, mode = 'agent') {
  const unsubs = [];
  let sawAssistantText = false;
  let lastAssistantMessage = '';
  let sessionError = null;
  let watchdogId = null;
  let activeStep = null;
  let lastStepSignature = '';
  let consecutiveStepCount = 0;
  const stepExecutionCounts = new Map();

  function serializeStepInput(input) {
    if (input == null) return 'null';
    if (typeof input === 'string') return input.slice(0, 180);
    try {
      return JSON.stringify(input).slice(0, 180);
    } catch (_) {
      return String(input).slice(0, 180);
    }
  }

  function abortSessionRun(reason, metadata = {}) {
    if (sessionError) return;
    sessionError = new Error(reason);
    sessionError.metadata = metadata;
    try {
      Promise.resolve(session.disconnect()).catch(() => {});
    } catch (_) {}
  }

  try {
    watchdogId = setInterval(() => {
      if (!activeStep || sessionError) return;
      const elapsedMs = Date.now() - activeStep.startedAt;
      if (elapsedMs <= TOOL_STEP_TIMEOUT_MS) return;
      abortSessionRun(
        `Step timeout: ${activeStep.tool} ran for ${Math.round(elapsedMs / 1000)}s (limit ${Math.round(TOOL_STEP_TIMEOUT_MS / 1000)}s).`
      );
    }, 1000);

    unsubs.push(session.on((event) => {
      const type = event?.type;
      const data = event?.data || {};

      if (type === 'assistant.reasoning_delta' && typeof data.deltaContent === 'string' && data.deltaContent) {
        sendEvent({ type: 'reasoning', content: data.deltaContent });
        return;
      }

      if (type === 'assistant.message_delta' && typeof data.deltaContent === 'string' && data.deltaContent) {
        sawAssistantText = true;
        sendEvent({ type: 'delta', content: data.deltaContent });
        return;
      }

      if (type === 'assistant.message') {
        const content = typeof data.content === 'string' ? data.content : '';
        if (content) {
          sawAssistantText = true;
          lastAssistantMessage = content;
          sendEvent({ type: 'message', content });
        }
        return;
      }

      if (type === 'tool.execution_start') {
        const tool = data.toolName || 'unknown_tool';
        const signature = `${tool}:${serializeStepInput(data.arguments ?? null)}`;

        if (signature === lastStepSignature) {
          consecutiveStepCount += 1;
        } else {
          lastStepSignature = signature;
          consecutiveStepCount = 1;
        }

        const seen = (stepExecutionCounts.get(signature) || 0) + 1;
        stepExecutionCounts.set(signature, seen);

        if (consecutiveStepCount >= MAX_CONSECUTIVE_IDENTICAL_STEPS) {
          abortSessionRun(
            `Possible recursive loop detected: repeated step "${tool}" ${consecutiveStepCount} times in a row.`,
            { isLoop: true }
          );
          return;
        }

        if (seen >= MAX_TOOL_EXECUTIONS_PER_SIGNATURE) {
          abortSessionRun(
            `Possible recursive loop detected: step "${tool}" ran ${seen} times with near-identical input.`,
            { isLoop: true }
          );
          return;
        }

        activeStep = {
          tool,
          signature,
          startedAt: Date.now(),
        };

        sendEvent({
          type: 'tool_call',
          tool,
          input: data.arguments ?? null,
        });
        return;
      }

      if (type === 'tool.execution_complete') {
        activeStep = null;
        sendEvent({
          type: 'tool_result',
          tool: data.toolName || 'unknown_tool',
          output: data.result ?? data.error ?? null,
        });
        return;
      }

      if (type === 'session.error') {
        sessionError = new Error(data.message || 'Session error');
      }
    }));

    let finalEvent;
    try {
      finalEvent = await session.sendAndWait({ prompt }, TWO_MINUTES_MS);
    } catch (err) {
      if (sessionError) throw sessionError;

      const errMsg = err?.message || 'Unknown session error';
      if (/session\.idle|timeout|timed.?out/i.test(errMsg)) {
        const activeStepHint = activeStep ? ` Last active step: ${activeStep.tool}.` : '';
        throw new Error(`Timeout after 2 minutes waiting for session.idle.${activeStepHint}`);
      }
      throw err;
    }

    if (sessionError) throw sessionError;
    const finalContent = typeof finalEvent?.data?.content === 'string' ? finalEvent.data.content : '';

    if (!sawAssistantText && finalContent) {
      sendEvent({ type: 'message', content: finalContent });
    } else if (!sawAssistantText && lastAssistantMessage) {
      sendEvent({ type: 'message', content: lastAssistantMessage });
    }
  } finally {
    if (watchdogId) clearInterval(watchdogId);
    unsubs.forEach((u) => u());
  }
}

function denyAllPermissions() {
  return { kind: 'denied-by-rules' };
}

function buildPlanModePrompt(message) {
  return [
    'You are in PLAN mode.',
    'Do not run tools.',
    'Do not read or write files.',
    'Do not execute commands.',
    'Do not ask for permission or confirmation.',
    'Return only final user-facing text.',
    'Your response must contain these exact sections and nothing else:',
    'Recommended Plan',
    'Possible Next Steps',
    'Under Recommended Plan, provide a concise ordered plan for how to approach the request.',
    'Under Possible Next Steps, provide a short numbered list of options the user could choose from.',
    'Do not include hidden reasoning, chain-of-thought, tool narration, or markdown code fences unless the user explicitly asked for code.',
    '',
    'User request:',
    message,
  ].join('\n');
}

function normalizePromptText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isPlanExecutionIntent(message) {
  const normalized = normalizePromptText(message);
  if (!normalized) return false;

  const executionPatterns = [
    /\bstart( implementing| implementation)?\b/,
    /\bbegin( implementing| implementation)?\b/,
    /\bgo ahead\b/,
    /\bdo it\b/,
    /\bimplement( it| this| that| the plan| these| those)?\b/,
    /\bmake (the )?changes\b/,
    /\bapply (the )?changes\b/,
    /\bexecute( the plan| this| it| these steps| step \d+)?\b/,
    /\bproceed\b/,
    /\bcarry (it|this) out\b/,
    /\bbuild it\b/,
    /\bship it\b/,
  ];

  return executionPatterns.some((pattern) => pattern.test(normalized));
}

function buildPlanModeHandoffMessage() {
  return [
    'You are still in plan mode, so I will not start implementing from here.',
    '',
    'Choose how you want to continue:',
    '1. Switch to agent mode to implement automatically.',
    '2. Switch to ask mode to review and approve changes before they are made.',
    '3. Stay in plan mode to refine or expand the plan only.',
  ].join('\n');
}

async function streamPlanReply(prompt, sendEvent) {
  if (!copilotClient) {
    throw new Error('Copilot client not available.');
  }

  const planningSession = await copilotClient.createSession({
    model: process.env.COPILOT_MODEL || 'gpt-5',
    streaming: false,
    onPermissionRequest: denyAllPermissions,
    systemMessage: {
      content: 'You are a planning assistant. Produce concise final answers only. Never use tools or make changes.',
    },
  });

  try {
    const result = await planningSession.sendAndWait({ prompt }, TWO_MINUTES_MS);
    const content = typeof result?.data?.content === 'string' ? result.data.content.trim() : '';
    if (!content) {
      throw new Error('Plan mode returned an empty response.');
    }
    sendEvent({ type: 'message', content });
  } finally {
    try { await planningSession.disconnect(); } catch (_) {}
  }
}

async function initCopilotAgent() {
  try {
    const { CopilotClient } = require('@github/copilot-sdk');
    const auth = resolveCopilotAuthConfig();
    activeCopilotAuthMode = auth.mode;

    copilotClient = new CopilotClient(auth.config);

    await copilotClient.start();
    console.log(`[copilot] client started (${activeCopilotAuthMode})`);

    await createAgentSession();
  } catch (err) {
    console.warn('[copilot] SDK init failed — chat endpoint disabled:', err.message);
    copilotClient = null;
    agentSession = null;
    activeCopilotAuthMode = 'unavailable';
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
  const { message, aiMode } = req.body;

  if (!message) {
    return res.status(400).json({ error: 'Message is required' });
  }

  if (!agentSession) {
    return res.status(503).json({ error: 'Copilot agent not initialised. Check Copilot auth/login for the selected auth mode.' });
  }

  if (agentBusy) {
    return res.status(429).json({ error: 'Agent is busy processing a previous request.' });
  }

  // --- Build mode-aware prompt ---
  let enhancedPrompt = message;
  const mode = String(aiMode || 'agent').toLowerCase().trim();
  
  switch (mode) {
    case 'ask':
      enhancedPrompt = `[MODE: ASK] Before making ANY file changes, you MUST ask the user for confirmation. Explain your plan and wait for approval. Only proceed if explicitly approved. Here is the request:\n\n${message}`;
      break;
    case 'plan':
      enhancedPrompt = buildPlanModePrompt(message);
      break;
    case 'agent':
    default:
      // Agent mode: proceed autonomously (default behavior)
      enhancedPrompt = `[MODE: AGENT] You are operating in autonomous agent mode. You have full permission to read/write files and execute commands. Proceed with the user's request:\n\n${message}`;
      break;
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
      if (mode === 'plan') {
        if (isPlanExecutionIntent(message)) {
          sendEvent({ type: 'message', content: buildPlanModeHandoffMessage() });
        } else {
          await streamPlanReply(enhancedPrompt, sendEvent);
        }
      } else {
        await streamAgentReply(agentSession, enhancedPrompt, sendEvent, mode);
      }
    } catch (err) {
      if (mode === 'plan' || !shouldRecreateAgentSession(err)) throw err;

      console.warn('[copilot] session invalid, recreating and retrying once');
      sendEvent({ type: 'tool_call', tool: 'copilot.session.reset', input: null });
      await createAgentSession();
      sendEvent({ type: 'tool_result', tool: 'copilot.session.reset', output: { ok: true, sessionId: agentSession.sessionId } });
      await streamAgentReply(agentSession, enhancedPrompt, sendEvent, mode);
    }

    sendEvent({ type: 'done' });
  } catch (err) {
    console.error('[copilot] chat error:', err);
    const message = err?.message || 'Unknown chat error';
    if (/authentication info|custom provider/i.test(message)) {
      sendEvent({
        type: 'error',
        message: 'Copilot auth is missing for the current mode. If using logged-in-user, sign in to Copilot on this machine. If using token mode, set GITHUB_TOKEN (or GH_TOKEN/COPILOT_GITHUB_TOKEN) and restart the server.',
      });
    } else {
      const isTimeout = /timeout|timed.?out/i.test(message);
      const metadata = err?.metadata || {};
      sendEvent({
        type: 'error',
        message: isTimeout ? 'Request timed out after 2 minutes.' : message,
        isTimeout,
        isLoop: Boolean(metadata.isLoop),
      });
    }
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

// Runtime info for UI/debugging of chat provider/auth mode
app.get('/api/chat/runtime', (req, res) => {
  res.json({
    provider: 'github-copilot-sdk',
    authMode: activeCopilotAuthMode,
    model: process.env.COPILOT_MODEL || 'gpt-5',
    ready: Boolean(agentSession),
  });
});

// =============================================================================
// GET /api/workspace  — return the current workspace path
// POST /api/workspace — change the workspace path at runtime
// =============================================================================

app.get('/api/workspace', (req, res) => {
  res.json({ path: WORKSPACE });
});

app.post('/api/workspace', (req, res) => {
  const newPath = req.body?.path;
  if (!newPath || typeof newPath !== 'string') {
    return res.status(400).json({ error: 'path required' });
  }

  const resolved = path.resolve(newPath);
  if (!fs.existsSync(resolved)) {
    return res.status(404).json({ error: 'Path does not exist' });
  }

  let stat;
  try { stat = fs.statSync(resolved); } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  if (!stat.isDirectory()) {
    return res.status(400).json({ error: 'Path must be a directory' });
  }

  WORKSPACE = resolved;
  try { process.chdir(WORKSPACE); } catch (_) {}
  console.log(`[workspace] changed to ${WORKSPACE}`);
  res.json({ path: WORKSPACE });
});

// =============================================================================
// GET /api/workspace/suggestions?prefix=<path-prefix>
// Returns matching directories for autocomplete in Settings.
// =============================================================================

app.get('/api/workspace/suggestions', (req, res) => {
  const rawPrefix = typeof req.query.prefix === 'string' ? req.query.prefix : '';
  const prefix = rawPrefix.trim();

  const normalized = prefix.length ? path.normalize(prefix) : '/';
  const hasTrailingSep = normalized.endsWith(path.sep);
  const baseDir = hasTrailingSep ? normalized : path.dirname(normalized);
  const partialName = hasTrailingSep ? '' : path.basename(normalized);

  let entries;
  try {
    entries = fs.readdirSync(baseDir, { withFileTypes: true });
  } catch (_) {
    return res.json({ suggestions: [] });
  }

  const suggestions = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith('.') && name.toLowerCase().startsWith(partialName.toLowerCase()))
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 20)
    .map((name) => {
      const full = path.join(baseDir, name);
      return full.endsWith(path.sep) ? full : `${full}${path.sep}`;
    });

  res.json({ suggestions });
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

// =============================================================================
// POST /api/file — save raw text content to a single file inside WORKSPACE
// Body: { path: '/relative/path', content: '...' }
// =============================================================================

app.post('/api/file', (req, res) => {
  const relPath = req.body?.path;
  const content = req.body?.content;

  if (!relPath || typeof relPath !== 'string') {
    return res.status(400).json({ error: 'path is required' });
  }
  if (typeof content !== 'string') {
    return res.status(400).json({ error: 'content must be a string' });
  }

  const abs = path.resolve(WORKSPACE, relPath.replace(/^\//, ''));
  if (!abs.startsWith(path.resolve(WORKSPACE))) {
    return res.status(403).json({ error: 'Access denied' });
  }

  let stat;
  try { stat = fs.statSync(abs); } catch {
    return res.status(404).json({ error: 'File not found' });
  }
  if (!stat.isFile()) return res.status(400).json({ error: 'Not a file' });

  try {
    fs.writeFileSync(abs, content, 'utf8');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =============================================================================
// Git API
// =============================================================================

function runGit(args, cwd) {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, { cwd, env: process.env });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (code !== 0) reject(new Error(stderr.trim() || `git exited ${code}`));
      else resolve(stdout);
    });
    proc.on('error', reject);
  });
}

function runGitWithAllowedCodes(args, cwd, allowedExitCodes = [0]) {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, { cwd, env: process.env });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (!allowedExitCodes.includes(code)) reject(new Error(stderr.trim() || `git exited ${code}`));
      else resolve(stdout);
    });
    proc.on('error', reject);
  });
}

function isGitRepo(dirPath) {
  return fs.existsSync(path.join(dirPath, '.git'));
}

function listWorkspaceRepos(rootPath) {
  const repos = [];
  const seen = new Set();
  const queue = [{ dir: rootPath, depth: 0 }];
  const MAX_DEPTH = 4;
  const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next']);

  while (queue.length) {
    const { dir, depth } = queue.shift();
    if (seen.has(dir)) continue;
    seen.add(dir);

    if (isGitRepo(dir)) {
      repos.push(dir);
      // Do not recurse into nested folders of a repo; treat each repo root as its own boundary.
      continue;
    }

    if (depth >= MAX_DEPTH) continue;

    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      entries = [];
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      if (entry.name.startsWith('.')) continue;
      queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
    }
  }

  return repos.sort((a, b) => a.localeCompare(b));
}

function normalizeRepoId(repoCwd) {
  const rel = path.relative(WORKSPACE, repoCwd).replace(/\\/g, '/');
  return rel && rel !== '' ? rel : '.';
}

function resolveRepoCwd(repoValue) {
  if (!repoValue || typeof repoValue !== 'string' || !repoValue.trim()) {
    return WORKSPACE;
  }

  const raw = repoValue.trim();
  const abs = raw === '.' ? WORKSPACE : path.resolve(WORKSPACE, raw);
  const root = path.resolve(WORKSPACE);

  if (!(abs === root || abs.startsWith(`${root}${path.sep}`))) {
    throw new Error('repo outside workspace');
  }

  if (!isGitRepo(abs)) {
    throw new Error('repo is not a git repository');
  }

  return abs;
}

function getRepoCwdFromRequest(req) {
  const repoValue = req.method === 'GET' ? req.query?.repo : req.body?.repo;
  return resolveRepoCwd(repoValue);
}

function hasExplicitRepoInRequest(req) {
  const repoValue = req.method === 'GET' ? req.query?.repo : req.body?.repo;
  return typeof repoValue === 'string' && repoValue.trim() !== '';
}

function parsePorcelain(raw) {
  const files = [];
  const lines = raw.split('\n');
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const xy = line.slice(0, 2);
    const file = line.slice(3).trim();
    const x = xy[0];
    const y = xy[1];

    if (xy === '??') {
      files.push({ path: file, status: '?', staged: false, unstaged: true, untracked: true });
      continue;
    }

    files.push({
      path: file,
      status: x !== ' ' && x !== '?' ? x : y,
      staged: x !== ' ' && x !== '?',
      unstaged: y !== ' ' && y !== '?',
      untracked: false,
    });
  }
  return files;
}

function parseNumstat(raw) {
  const map = new Map();
  const lines = raw.split('\n').filter(Boolean);
  for (const line of lines) {
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const added = parts[0] === '-' ? 0 : parseInt(parts[0], 10) || 0;
    const removed = parts[1] === '-' ? 0 : parseInt(parts[1], 10) || 0;
    const file = parts.slice(2).join('\t').trim();
    map.set(file, { added, removed });
  }
  return map;
}

function getFileMtimeMs(repoCwd, repoRelativePath) {
  try {
    const absPath = path.resolve(repoCwd, repoRelativePath);
    const stat = fs.statSync(absPath);
    return Number.isFinite(stat.mtimeMs) ? Math.round(stat.mtimeMs) : 0;
  } catch (_) {
    return 0;
  }
}

async function getGitChangeSummary(repoCwd = WORKSPACE) {
  const statusRaw = await runGit(['status', '--porcelain=v1', '-b', '--untracked-files=all'], repoCwd);
  const files = parsePorcelain(statusRaw);

  const numstatHead = parseNumstat(await runGit(['diff', '--numstat', 'HEAD'], repoCwd));
  const byPath = new Map();

  for (const file of files) {
    const stat = numstatHead.get(file.path) || { added: 0, removed: 0 };
    byPath.set(file.path, {
      path: file.path,
      status: file.status,
      added: stat.added,
      removed: stat.removed,
      mtimeMs: getFileMtimeMs(repoCwd, file.path),
      staged: file.staged,
      unstaged: file.unstaged,
      untracked: file.untracked,
    });
  }

  const rows = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
  const totals = rows.reduce(
    (acc, row) => ({ files: acc.files + 1, added: acc.added + row.added, removed: acc.removed + row.removed }),
    { files: 0, added: 0, removed: 0 }
  );

  return { totals, files: rows };
}

function toWorkspaceRelativePath(repoCwd, repoRelativePath) {
  const absolutePath = path.resolve(repoCwd, repoRelativePath);
  return path.relative(WORKSPACE, absolutePath).replace(/\\/g, '/');
}

async function getWorkspaceGitChangeSummary() {
  const repoPaths = listWorkspaceRepos(WORKSPACE);
  const allFiles = [];

  for (const repoCwd of repoPaths) {
    const repoId = normalizeRepoId(repoCwd);
    const repoName = path.basename(repoCwd);
    const summary = await getGitChangeSummary(repoCwd);

    for (const file of summary.files) {
      allFiles.push({
        ...file,
        path: toWorkspaceRelativePath(repoCwd, file.path),
        repo: repoId,
        repoName,
      });
    }
  }

  allFiles.sort((a, b) => a.path.localeCompare(b.path));

  const totals = allFiles.reduce(
    (acc, row) => ({ files: acc.files + 1, added: acc.added + row.added, removed: acc.removed + row.removed }),
    { files: 0, added: 0, removed: 0 }
  );

  return { totals, files: allFiles };
}

// Returns the unified diff patch for a single file.
// If a snapshot was captured at the last Keep, diffs against that snapshot so
// only changes SINCE the last keep are shown.  Falls back to HEAD otherwise.
async function getPatchForFile(file, repoCwd) {
  const absPath = path.resolve(repoCwd, file.path);
  const wsKey = path.relative(WORKSPACE, absPath).replace(/\\/g, '/');
  const snapshotContent = keepSnapshots.get(wsKey);

  if (snapshotContent !== undefined) {
    const tmpFile = path.join(os.tmpdir(), `pocketide-snap-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      fs.writeFileSync(tmpFile, snapshotContent, 'utf8');
      return await runGitWithAllowedCodes(
        ['diff', '--no-index', '--no-color', '--unified=3', '--', tmpFile, absPath],
        repoCwd,
        [0, 1]
      );
    } finally {
      try { fs.unlinkSync(tmpFile); } catch (_) {}
    }
  }

  if (file.untracked) {
    return await runGitWithAllowedCodes(
      ['diff', '--no-index', '--no-color', '--unified=3', '--', '/dev/null', file.path],
      repoCwd,
      [0, 1]
    );
  }
  return await runGit(['diff', '--no-color', '--unified=3', 'HEAD', '--', file.path], repoCwd);
}

async function getWorkspaceGitDiffDetails() {
  const repoPaths = listWorkspaceRepos(WORKSPACE);
  const files = [];

  for (const repoCwd of repoPaths) {
    const repoId = normalizeRepoId(repoCwd);
    const repoName = path.basename(repoCwd);
    const summary = await getGitChangeSummary(repoCwd);

    for (const file of summary.files) {
      const patch = await getPatchForFile(file, repoCwd);

      if (!patch.trim()) continue;

      files.push({
        path: toWorkspaceRelativePath(repoCwd, file.path),
        repo: repoId,
        repoName,
        status: file.status,
        added: file.added || 0,
        removed: file.removed || 0,
        patch,
      });
    }
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  const totals = files.reduce(
    (acc, file) => ({
      files: acc.files + 1,
      added: acc.added + (file.added || 0),
      removed: acc.removed + (file.removed || 0),
    }),
    { files: 0, added: 0, removed: 0 }
  );

  return { totals, files };
}

function buildHeuristicCommitMessage(stagedFiles) {
  const names = stagedFiles.map((f) => path.basename(f.path));
  if (names.length === 1) {
    return `update ${names[0]}`;
  }
  if (names.length === 2) {
    return `update ${names[0]} and ${names[1]}`;
  }
  const preview = names.slice(0, 2).join(', ');
  return `update ${names.length} files (${preview}...)`;
}

function extractSingleLineMessage(content) {
  if (!content || typeof content !== 'string') return '';
  const cleaned = content
    .replace(/```[\s\S]*?```/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const firstLine = cleaned[0] || '';
  return firstLine.replace(/^[-*]\s+/, '').replace(/^"|"$/g, '').trim();
}

function buildCommitMessagePrompt(stagedFiles) {
  const summaryLines = stagedFiles
    .slice(0, 50)
    .map((f) => `- ${f.path} (${f.status || 'modified'})`)
    .join('\n');

  return [
    'Write a single Git commit message for these staged changes.',
    'Rules:',
    '- Return exactly one line of plain text.',
    '- Use imperative mood.',
    '- Max 72 characters.',
    '- No quotes, no markdown, no code fences.',
    '',
    'Staged files:',
    summaryLines || '- (none)',
  ].join('\n');
}

async function generateAiCommitMessage(stagedFiles) {
  if (!copilotClient) {
    throw new Error('Copilot client not available. Start server with valid auth first.');
  }

  const { approveAll } = require('@github/copilot-sdk');
  const oneShotSession = await copilotClient.createSession({
    model: process.env.COPILOT_MODEL || 'gpt-5',
    streaming: false,
    onPermissionRequest: approveAll,
    systemMessage: {
      content: 'You are a concise Git commit message assistant.',
    },
  });

  try {
    const result = await oneShotSession.sendAndWait({
      prompt: buildCommitMessagePrompt(stagedFiles),
    }, TWO_MINUTES_MS);

    const message = extractSingleLineMessage(result?.data?.content || '');
    if (!message) {
      throw new Error('AI returned an empty commit message.');
    }

    return message;
  } finally {
    try { await oneShotSession.disconnect(); } catch (_) {}
  }
}

function hasLocalChangesFromStatus(statusRaw) {
  const lines = statusRaw.split('\n').slice(1);
  return lines.some((line) => Boolean(line.trim()));
}

async function localBranchExists(localName, repoCwd) {
  try {
    await runGit(['show-ref', '--verify', '--quiet', `refs/heads/${localName}`], repoCwd);
    return true;
  } catch (_) {
    return false;
  }
}

async function resolveCheckoutArgs(branch, remote, force, repoCwd) {
  if (!remote) {
    return ['checkout', ...(force ? ['--force'] : []), branch];
  }

  const localName = branch.replace(/^[^/]+\//, '').trim();
  if (!localName || localName === branch) {
    throw new Error('Invalid remote branch name');
  }

  const exists = await localBranchExists(localName, repoCwd);
  if (exists) {
    return ['checkout', ...(force ? ['--force'] : []), localName];
  }

  return ['checkout', ...(force ? ['--force'] : []), '-b', localName, '--track', branch];
}

function resolveWorkspaceRelativePath(inputPath) {
  const normalized = String(inputPath || '').replace(/^\/+/, '');
  const abs = path.resolve(WORKSPACE, normalized);
  const root = path.resolve(WORKSPACE);
  if (!(abs === root || abs.startsWith(`${root}${path.sep}`))) {
    throw new Error('path outside workspace');
  }
  const rel = path.relative(root, abs).replace(/\\/g, '/');
  if (!rel || rel.startsWith('..')) {
    throw new Error('invalid path');
  }
  return rel;
}

// GET /api/git/status  →  { branch, ahead, behind, staged, unstaged, untracked }
app.get('/api/git/status', async (req, res) => {
  try {
    const repoCwd = getRepoCwdFromRequest(req);
    const raw = await runGit(['status', '--porcelain=v1', '-b', '--untracked-files=all'], repoCwd);
    const lines = raw.split('\n');
    const branchLine = lines[0] || '';

    // Parse branch / ahead / behind from ## line
    // e.g. "## main...origin/main [ahead 1, behind 2]"
    const branchMatch = branchLine.match(/^## (.+?)(?:\.\.\.(\S+))?(?:\s+\[(.+?)\])?$/);
    let branch = branchMatch ? branchMatch[1] : 'HEAD';
    let ahead = 0;
    let behind = 0;
    if (branchMatch && branchMatch[3]) {
      const aMatch = branchMatch[3].match(/ahead (\d+)/);
      const bMatch = branchMatch[3].match(/behind (\d+)/);
      if (aMatch) ahead = parseInt(aMatch[1], 10);
      if (bMatch) behind = parseInt(bMatch[1], 10);
    }
    // Handle "No commits yet" case
    if (branch.startsWith('No commits yet on ')) {
      branch = branch.replace('No commits yet on ', '');
    }

    const staged = [];
    const unstaged = [];
    const untracked = [];

    for (const line of lines.slice(1)) {
      if (!line.trim()) continue;
      const xy = line.slice(0, 2);
      const file = line.slice(3).trim();
      const x = xy[0]; // index (staged) status
      const y = xy[1]; // worktree (unstaged) status

      if (xy === '??') {
        untracked.push({ path: file, status: '?' });
        continue;
      }
      if (x !== ' ' && x !== '?') {
        staged.push({ path: file, status: x });
      }
      if (y !== ' ' && y !== '?') {
        unstaged.push({ path: file, status: y });
      }
    }

    // Resolve repo name from git toplevel directory
    let repoName = null;
    try {
      const toplevel = await runGit(['rev-parse', '--show-toplevel'], repoCwd);
      repoName = path.basename(toplevel.trim());
    } catch (_) {
      repoName = path.basename(repoCwd);
    }

    res.json({ repo: normalizeRepoId(repoCwd), repoName, branch, ahead, behind, staged, unstaged, untracked });
  } catch (err) {
    // Not a git repo or no git
    if (err.message.includes('not a git repository') || err.message.includes('fatal:')) {
      return res.json({ repoName: null, branch: null, ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [] });
    }
    res.status(500).json({ error: err.message });
  }
});

// GET /api/git/repos → { repos: [{ id, name, path }] }
app.get('/api/git/repos', async (req, res) => {
  try {
    const repoPaths = listWorkspaceRepos(WORKSPACE);
    const repos = repoPaths.map((repoPath) => ({
      id: normalizeRepoId(repoPath),
      name: path.basename(repoPath),
      path: repoPath,
    }));
    res.json({ repos });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/git/changes-summary → { totals: { files, added, removed }, files: [...] }
app.get('/api/git/changes-summary', async (req, res) => {
  try {
    const summary = hasExplicitRepoInRequest(req)
      ? await getGitChangeSummary(getRepoCwdFromRequest(req))
      : await getWorkspaceGitChangeSummary();
    res.json(summary);
  } catch (err) {
    if (err.message.includes('not a git repository') || err.message.includes('fatal:')) {
      return res.json({ totals: { files: 0, added: 0, removed: 0 }, files: [] });
    }
    res.status(500).json({ error: err.message });
  }
});

// GET /api/git/changes-diff → { totals: { files, added, removed }, files: [{ path, patch, ... }] }
app.get('/api/git/changes-diff', async (req, res) => {
  try {
    const summary = hasExplicitRepoInRequest(req)
      ? await (async () => {
        const repoCwd = getRepoCwdFromRequest(req);
        const repoId = normalizeRepoId(repoCwd);
        const repoName = path.basename(repoCwd);
        const base = await getGitChangeSummary(repoCwd);
        const files = [];

        for (const file of base.files) {
          const patch = await getPatchForFile(file, repoCwd);

          if (!patch.trim()) continue;
          files.push({
            ...file,
            path: file.path,
            repo: repoId,
            repoName,
            patch,
          });
        }

        const totals = files.reduce(
          (acc, file) => ({ files: acc.files + 1, added: acc.added + (file.added || 0), removed: acc.removed + (file.removed || 0) }),
          { files: 0, added: 0, removed: 0 }
        );

        return { totals, files };
      })()
      : await getWorkspaceGitDiffDetails();
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/git/keep-snapshot  body: { paths: string[], repo?: string }
// Captures the current content of each path so that subsequent /api/git/changes-diff
// calls show only what changed SINCE this snapshot rather than since HEAD.
app.post('/api/git/keep-snapshot', (req, res) => {
  const { paths } = req.body || {};
  if (!Array.isArray(paths) || !paths.length) return res.status(400).json({ error: 'paths required' });

  const repoCwd = hasExplicitRepoInRequest(req) ? getRepoCwdFromRequest(req) : WORKSPACE;

  for (const filePath of paths) {
    try {
      const absPath = path.resolve(repoCwd, filePath);
      const wsKey = path.relative(WORKSPACE, absPath).replace(/\\/g, '/');
      if (wsKey.startsWith('..')) continue;
      if (!fs.existsSync(absPath)) continue;
      keepSnapshots.set(wsKey, fs.readFileSync(absPath, 'utf8'));
    } catch (_) {}
  }

  res.json({ ok: true });
});

// GET /api/git/branches → { branches: [{ name, fullName, current, upstream, remote }] }
app.get('/api/git/branches', async (req, res) => {
  try {
    const repoCwd = getRepoCwdFromRequest(req);
    const localRaw = await runGit(['branch', '--format=%(refname:short)%09%(HEAD)%09%(upstream:short)'], repoCwd);
    const localBranches = localRaw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [name = '', head = '', upstream = ''] = line.split('\t');
        return {
          name: name.trim(),
          fullName: name.trim(),
          current: head.trim() === '*',
          upstream: upstream.trim() || null,
          remote: false,
        };
      });

    const remoteRaw = await runGit(['branch', '-r', '--format=%(refname:short)'], repoCwd);
    const remoteBranches = remoteRaw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((name) => name.includes('/'))
      .filter((name) => !/\/HEAD$/.test(name))
      .map((name) => ({
        name,
        fullName: name,
        current: false,
        upstream: null,
        remote: true,
      }));

    const branches = [
      ...localBranches.sort((a, b) => {
        if (a.current !== b.current) return a.current ? -1 : 1;
        return a.name.localeCompare(b.name);
      }),
      ...remoteBranches.sort((a, b) => a.name.localeCompare(b.name)),
    ];

    res.json({ repo: normalizeRepoId(repoCwd), branches });
  } catch (err) {
    if (err.message.includes('not a git repository') || err.message.includes('fatal:')) {
      return res.json({ branches: [] });
    }
    res.status(500).json({ error: err.message });
  }
});

// POST /api/git/stage  body: { path } or { all: true }
app.post('/api/git/stage', async (req, res) => {
  try {
    const repoCwd = getRepoCwdFromRequest(req);
    const { path: filePath, all } = req.body || {};
    if (all) {
      await runGit(['add', '-A'], repoCwd);
    } else {
      if (!filePath || typeof filePath !== 'string') return res.status(400).json({ error: 'path required' });
      // Normalise to relative path within workspace
      const rel = path.relative(repoCwd, path.resolve(repoCwd, filePath));
      if (rel.startsWith('..')) return res.status(400).json({ error: 'path outside workspace' });
      await runGit(['add', rel], repoCwd);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/git/unstage  body: { path } or { all: true }
app.post('/api/git/unstage', async (req, res) => {
  try {
    const repoCwd = getRepoCwdFromRequest(req);
    const { path: filePath, all } = req.body || {};
    if (all) {
      await runGit(['restore', '--staged', '.'], repoCwd);
    } else {
      if (!filePath || typeof filePath !== 'string') return res.status(400).json({ error: 'path required' });
      const rel = path.relative(repoCwd, path.resolve(repoCwd, filePath));
      if (rel.startsWith('..')) return res.status(400).json({ error: 'path outside workspace' });
      await runGit(['restore', '--staged', rel], repoCwd);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/git/commit  body: { message }
app.post('/api/git/commit', async (req, res) => {
  try {
    const repoCwd = getRepoCwdFromRequest(req);
    const { message } = req.body || {};
    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'commit message required' });
    }
    const output = await runGit(['commit', '-m', message.trim()], repoCwd);
    res.json({ ok: true, output: output.trim() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/git/generate-commit-message → { message, source }
app.post('/api/git/generate-commit-message', async (req, res) => {
  try {
    const repoCwd = getRepoCwdFromRequest(req);
    const statusRaw = await runGit(['status', '--porcelain=v1', '-b', '--untracked-files=all'], repoCwd);
    const files = parsePorcelain(statusRaw);
    const stagedFiles = files.filter((f) => f.staged);

    if (stagedFiles.length === 0) {
      return res.status(400).json({ error: 'No staged files. Stage files first to generate a commit message.' });
    }

    const message = await generateAiCommitMessage(stagedFiles);
    res.json({ message, source: 'ai' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/git/checkout  body: { branch, strategy?: 'stash' | 'force' }
app.post('/api/git/checkout', async (req, res) => {
  try {
    const repoCwd = getRepoCwdFromRequest(req);
    const branch = typeof req.body?.branch === 'string' ? req.body.branch.trim() : '';
    const strategy = typeof req.body?.strategy === 'string' ? req.body.strategy : null;
    const remote = Boolean(req.body?.remote);

    if (!branch) {
      return res.status(400).json({ error: 'branch required' });
    }
    if (strategy && !['stash', 'force'].includes(strategy)) {
      return res.status(400).json({ error: 'strategy must be stash or force' });
    }

    const statusRaw = await runGit(['status', '--porcelain=v1', '-b', '--untracked-files=all'], repoCwd);
    const hasChanges = hasLocalChangesFromStatus(statusRaw);

    if (!strategy && hasChanges) {
      return res.status(409).json({
        conflict: true,
        error: 'You have uncommitted changes. Choose stash or force to switch branches.',
      });
    }

    if (strategy === 'force') {
      const checkoutArgs = await resolveCheckoutArgs(branch, remote, true, repoCwd);
      const output = await runGit(checkoutArgs, repoCwd);
      return res.json({ ok: true, output: output.trim() });
    }

    if (strategy === 'stash') {
      const stashMessage = `pocketide:auto-stash:${new Date().toISOString()}`;
      const stashOutput = await runGit(['stash', 'push', '-u', '-m', stashMessage], repoCwd);
      const checkoutArgs = await resolveCheckoutArgs(branch, remote, false, repoCwd);
      const output = await runGit(checkoutArgs, repoCwd);

      if (!/No local changes to save/i.test(stashOutput)) {
        try {
          await runGit(['stash', 'pop'], repoCwd);
        } catch (popErr) {
          return res.json({
            ok: true,
            output: output.trim(),
            warning: `Switched branches, but stash pop had conflicts: ${popErr.message}`,
          });
        }
      }

      return res.json({ ok: true, output: output.trim() });
    }

    const checkoutArgs = await resolveCheckoutArgs(branch, remote, false, repoCwd);
    const output = await runGit(checkoutArgs, repoCwd);
    res.json({ ok: true, output: output.trim() });
  } catch (err) {
    if (/would be overwritten|Your local changes/i.test(err.message || '')) {
      return res.status(409).json({
        conflict: true,
        error: err.message,
      });
    }
    res.status(500).json({ error: err.message });
  }
});

// POST /api/git/branch/create  body: { name, from?, repo }
app.post('/api/git/branch/create', async (req, res) => {
  try {
    const repoCwd = getRepoCwdFromRequest(req);
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const from = typeof req.body?.from === 'string' ? req.body.from.trim() : '';

    if (!name) {
      return res.status(400).json({ error: 'Branch name is required.' });
    }
    if (/\s/.test(name)) {
      return res.status(400).json({ error: 'Branch name cannot contain spaces.' });
    }

    const exists = await localBranchExists(name, repoCwd);
    if (exists) {
      return res.status(400).json({ error: `Branch ${name} already exists.` });
    }

    const args = from
      ? (/^origin\//.test(from)
          ? ['checkout', '-b', name, '--track', from]
          : ['checkout', '-b', name, from])
      : ['checkout', '-b', name];

    const output = await runGit(args, repoCwd);
    res.json({ ok: true, output: output.trim(), branch: name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/git/discard-changes  body: { paths: ["src/file.js", ...] }
app.post('/api/git/discard-changes', async (req, res) => {
  try {
    const paths = req.body?.paths;
    if (!Array.isArray(paths)) {
      return res.status(400).json({ error: 'paths must be an array' });
    }

    const relPaths = [];
    for (const filePath of paths) {
      if (typeof filePath !== 'string' || !filePath.trim()) {
        return res.status(400).json({ error: 'each path must be a non-empty string' });
      }
      relPaths.push(resolveWorkspaceRelativePath(filePath.trim()));
    }

    for (const relPath of relPaths) {
      let isTracked = true;
      try {
        await runGit(['ls-files', '--error-unmatch', '--', relPath], WORKSPACE);
      } catch (_) {
        isTracked = false;
      }

      if (isTracked) {
        await runGit(['restore', '--staged', '--worktree', '--', relPath], WORKSPACE);
      } else {
        fs.rmSync(path.resolve(WORKSPACE, relPath), { recursive: true, force: true });
      }
    }

    res.json({ ok: true, reverted: relPaths.length, paths: relPaths });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/git/push  body: {} (pushes current branch to its tracking remote)
app.post('/api/git/push', async (req, res) => {
  try {
    const repoCwd = getRepoCwdFromRequest(req);
    const output = await runGit(['push'], repoCwd);
    res.json({ ok: true, output: output.trim() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/git/pull
app.post('/api/git/pull', async (req, res) => {
  try {
    const repoCwd = getRepoCwdFromRequest(req);
    const output = await runGit(['pull', '--no-rebase'], repoCwd);
    res.json({ ok: true, output: output.trim() });
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

function resolveShellArgs(shellPath) {
  const base = path.basename(shellPath || '').toLowerCase();

  // Use interactive mode so arrow-key history works when possible.
  if (base === 'zsh' || base === 'bash' || base === 'sh') {
    return ['-i'];
  }

  return [];
}

io.on('connection', (socket) => {
  console.log(`[terminal] client connected: ${socket.id}`);

  const shellPath = resolveShellPath();
  const shellArgs = resolveShellArgs(shellPath);
  let shell;
  let isPty = false;

  try {
    shell = pty.spawn(shellPath, shellArgs, {
      name: 'xterm-color',
      cwd: WORKSPACE,
      env: { ...process.env, TERM: 'xterm-color' },
    });
    isPty = true;
  } catch (err) {
    console.error(`[terminal] failed to spawn shell for ${socket.id}:`, err.message);

    // Fallback for environments where node-pty cannot spawn (e.g. ABI/runtime issues).
    shell = spawn(shellPath, shellArgs, {
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
      try { shell.write(data); } catch (_) {}
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
