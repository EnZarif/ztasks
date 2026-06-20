// Tails ~/.claude/projects/**/*.jsonl and pushes live agent status to Supabase
// for the "Pixel Office" widget in index.html. Local-only by necessity: Claude
// Code's session transcripts only exist on this machine.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://qwceyzswwtyqiozxnlah.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_7iT7MOE7JMGv5Vl0j_13iw_s5tyQTMJ';
const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const POLL_MS = 3000;
const IDLE_AFTER_MS = 90 * 1000;
const STALE_AFTER_MS = 15 * 60 * 1000;

const READ_TOOLS = new Set(['Read', 'Glob', 'Grep']);
const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);

// sessionId -> { offset, status, lastTool, lastChangeTs, projectPath, characterIndex }
const sessions = new Map();

function hashToCharacterIndex(sessionId) {
  let h = 0;
  for (let i = 0; i < sessionId.length; i++) h = (h * 31 + sessionId.charCodeAt(i)) >>> 0;
  return h % 6;
}

function findJsonlFiles() {
  const out = [];
  let projectDirs;
  try {
    projectDirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const dirent of projectDirs) {
    if (!dirent.isDirectory()) continue;
    const dirPath = path.join(PROJECTS_DIR, dirent.name);
    let files;
    try {
      files = fs.readdirSync(dirPath);
    } catch {
      continue;
    }
    for (const f of files) {
      if (f.endsWith('.jsonl')) out.push(path.join(dirPath, f));
    }
  }
  return out;
}

function statusFromEntry(entry) {
  if (entry.type === 'assistant' && Array.isArray(entry.message?.content)) {
    const toolUse = entry.message.content.find((c) => c.type === 'tool_use');
    if (toolUse) {
      const name = toolUse.name;
      if (READ_TOOLS.has(name)) return { status: 'reading', tool: name };
      if (WRITE_TOOLS.has(name)) return { status: 'typing', tool: name };
      if (name === 'Bash') return { status: 'running', tool: name };
      if (name === 'Task') return { status: 'delegating', tool: name };
      return { status: 'running', tool: name };
    }
    const hasText = entry.message.content.some((c) => c.type === 'text');
    if (hasText) return { status: 'waiting', tool: null };
  }
  return null;
}

function processFile(filePath, sessionId) {
  const stat = fs.statSync(filePath);
  const now = Date.now();
  const prev = sessions.get(sessionId);
  const offset = prev?.offset ?? 0;

  if (stat.size < offset) {
    // File shrank/rotated — restart from scratch
    sessions.delete(sessionId);
    return processFile(filePath, sessionId);
  }
  if (stat.size === offset && prev) {
    maybeMarkIdle(sessionId, now);
    return;
  }

  const fd = fs.openSync(filePath, 'r');
  const length = stat.size - offset;
  const buf = Buffer.alloc(length);
  fs.readSync(fd, buf, 0, length, offset);
  fs.closeSync(fd);

  const chunk = buf.toString('utf8');
  const lines = chunk.split('\n').filter(Boolean);

  let projectPath = prev?.projectPath;
  let status = prev?.status ?? 'idle';
  let lastTool = prev?.lastTool ?? null;
  let lastChangeTs = now;

  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.cwd) projectPath = entry.cwd;
    if (entry.type === 'user' && entry.message?.role === 'user') {
      status = 'thinking';
      lastTool = null;
    }
    const inferred = statusFromEntry(entry);
    if (inferred) {
      status = inferred.status;
      lastTool = inferred.tool;
    }
  }

  sessions.set(sessionId, {
    offset: stat.size,
    status,
    lastTool,
    lastChangeTs,
    projectPath,
    characterIndex: prev?.characterIndex ?? hashToCharacterIndex(sessionId),
  });
}

function maybeMarkIdle(sessionId, now) {
  const s = sessions.get(sessionId);
  if (!s) return;
  if (s.status !== 'idle' && now - s.lastChangeTs > IDLE_AFTER_MS) {
    s.status = 'idle';
  }
}

async function syncToSupabase() {
  const now = Date.now();
  for (const [sessionId, s] of sessions) {
    if (now - s.lastChangeTs > STALE_AFTER_MS) {
      sessions.delete(sessionId);
      await sb.from('pixel_agents').delete().eq('session_id', sessionId);
      continue;
    }
    maybeMarkIdle(sessionId, now);
    const { error } = await sb.from('pixel_agents').upsert({
      session_id: sessionId,
      project_path: s.projectPath ?? null,
      status: s.status,
      last_tool: s.lastTool,
      character_index: s.characterIndex,
      updated_at: new Date().toISOString(),
    });
    if (error) console.error('[pixel-agents] upsert error for', sessionId, error.message);
  }
}

async function tick() {
  const now = Date.now();
  const files = findJsonlFiles();
  for (const filePath of files) {
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }
    if (now - stat.mtimeMs > STALE_AFTER_MS) continue;
    const sessionId = path.basename(filePath, '.jsonl');
    try {
      processFile(filePath, sessionId);
    } catch (err) {
      console.error('[pixel-agents] failed to process', filePath, err.message);
    }
  }
  await syncToSupabase();
}

console.log('[pixel-agents] watching', PROJECTS_DIR);
tick();
setInterval(tick, POLL_MS);
