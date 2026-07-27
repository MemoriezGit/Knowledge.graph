#!/usr/bin/env node
/**
 * One command to get connected: `npm run setup`.
 *
 * Checks every link, fixes what it can, and prints only what you still have to
 * do yourself. Safe to re-run any time — it's also the "is this still working?"
 * command.
 */
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config, providerStatus } from '../server/config.js';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const MCP_ENTRY = path.join(ROOT, 'mcp', 'server.js');

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

const todo = [];
let broken = false;

const ok = (msg, detail) => console.log(`  ${c.green('✓')} ${msg}${detail ? c.dim(`  ${detail}`) : ''}`);
const info = (msg, detail) => console.log(`  ${c.dim('·')} ${msg}${detail ? c.dim(`  ${detail}`) : ''}`);
const fail = (msg, detail) => {
  broken = true;
  console.log(`  ${c.red('✗')} ${msg}${detail ? c.dim(`  ${detail}`) : ''}`);
};

console.log(`\n${c.bold(`Setting up ${config.brainName}`)}\n`);

// ── 1. the brain ─────────────────────────────────────────────────────────────

const status = providerStatus();

if (status.provider === 'claude-code') {
  try {
    await execFileAsync('claude', ['--version'], { timeout: 20000 });
  } catch {
    fail('Claude Code not installed', 'npm install -g @anthropic-ai/claude-code');
  }
  if (!broken) {
    // \r only clears on a terminal; when piped it would be printed literally.
    const spinner = process.stdout.isTTY ? '  · checking your Claude subscription…' : null;
    const clearSpinner = () => spinner && process.stdout.write(`\r${' '.repeat(spinner.length)}\r`);
    if (spinner) process.stdout.write(c.dim(spinner));
    try {
      const { stdout } = await execFileAsync('claude', ['-p', 'Say OK', '--output-format', 'json'], {
        timeout: 120000,
        maxBuffer: 10 * 1024 * 1024,
      });
      clearSpinner();
      if (JSON.parse(stdout).is_error) fail('Claude Code is signed in but returned an error');
      else ok('Brain', 'running on your Claude subscription — no API bill');
    } catch {
      clearSpinner();
      fail('Claude Code is not signed in', 'run `claude` once and log in with your Pro/Max plan');
    }
  }
} else if (status.provider === 'anthropic') {
  if (config.anthropic.apiKey) ok('Brain', `Claude API · ${config.anthropic.model}`);
  else {
    fail('No brain configured');
    todo.push(
      'Pick one:\n' +
        `      ${c.cyan('Use your Claude subscription')} — install Claude Code and run \`claude\` to sign in:\n` +
        '          npm install -g @anthropic-ai/claude-code && claude\n' +
        `      ${c.cyan('Use an API key')} — put ANTHROPIC_API_KEY or OPENAI_API_KEY in .env`,
    );
  }
} else if (config.openai.apiKey) {
  ok('Brain', `OpenAI API · ${config.openai.model}`);
} else {
  fail('OPENAI_API_KEY missing', 'ChatGPT Plus does not include API access — see docs/SUBSCRIPTIONS.md');
}

if (config.openai.apiKey) ok('Voice & recall', 'OpenAI voice + semantic search');
else info('Voice & recall', 'browser voice, keyword search — add OPENAI_API_KEY to upgrade both');

// ── 2. .env ──────────────────────────────────────────────────────────────────

const envPath = path.join(ROOT, '.env');
if (!fs.existsSync(envPath)) {
  // A minimal .env with a stable MCP token, so the ChatGPT connector keeps
  // working across restarts instead of needing reconfiguration each time.
  const token = (await import('node:crypto')).randomBytes(24).toString('base64url');
  fs.writeFileSync(
    envPath,
    [
      '# Created by `npm run setup`. Everything here is optional.',
      '# See .env.example for the full list of settings.',
      '',
      `MCP_TOKEN=${token}`,
      '',
    ].join('\n'),
  );
  ok('Created .env', 'with a stable connector token');
} else if (!/^MCP_TOKEN=.+/m.test(fs.readFileSync(envPath, 'utf8'))) {
  const token = (await import('node:crypto')).randomBytes(24).toString('base64url');
  fs.appendFileSync(envPath, `\n# Connector token for ChatGPT (stable across restarts)\nMCP_TOKEN=${token}\n`);
  ok('Added a connector token to .env');
} else {
  ok('.env ready');
}
const mcpToken = /^MCP_TOKEN=(.+)$/m.exec(fs.readFileSync(envPath, 'utf8'))?.[1]?.trim();

// ── 3. connect Claude ────────────────────────────────────────────────────────

let claudeConnected = false;
try {
  const { stdout } = await execFileAsync('claude', ['mcp', 'list'], { timeout: 30000 });
  if (/second-brain/.test(stdout)) {
    ok('Claude Code connected', 'second-brain is registered');
    claudeConnected = true;
  } else {
    await execFileAsync('claude', ['mcp', 'add', 'second-brain', '--', 'node', MCP_ENTRY], { timeout: 30000 });
    ok('Claude Code connected', 'registered second-brain for you');
    claudeConnected = true;
  }
} catch {
  info('Claude Code not available', 'skipping automatic connection');
}

// ── 4. verify the bridge actually answers ────────────────────────────────────

const probe = await probeMcp();
if (probe.ok) ok('Memory tools', `${probe.tools} available to any connected app`);
else fail('MCP bridge failed', probe.error);

// ── what's left for you ──────────────────────────────────────────────────────

console.log('');
if (broken) {
  console.log(c.bold('Finish these, then re-run `npm run setup`:\n'));
  for (const t of todo) console.log(`  ${t}\n`);
  if (!todo.length) console.log(c.dim('  See the messages above.\n'));
  process.exit(1);
}

console.log(c.bold('You’re ready.\n'));
console.log(`  Start it:      ${c.cyan('npm start')}          ${c.dim(`then open http://localhost:${config.port}`)}`);
if (claudeConnected) {
  console.log(`  Claude:        ${c.green('connected')}          ${c.dim('restart Claude Desktop if it was open')}`);
} else {
  console.log(`  Claude Desktop: ${c.dim('Settings → Developer → Edit Config, add:')}`);
  console.log(
    c.dim(
      JSON.stringify({ mcpServers: { 'second-brain': { command: 'node', args: [MCP_ENTRY] } } }, null, 2)
        .split('\n')
        .map((l) => `                  ${l}`)
        .join('\n'),
    ),
  );
}
console.log(`  ChatGPT:       ${c.dim('Settings → Connectors → Advanced → Developer mode, then add')}`);
console.log(`                 URL    ${c.cyan(`http://localhost:${config.port}/mcp`)}`);
console.log(`                 Token  ${c.cyan(mcpToken || '(see .env)')}`);
console.log(
  c.dim(`                 ChatGPT must reach that URL, so from a laptop run:\n` +
    `                   cloudflared tunnel --url http://localhost:${config.port}`),
);
console.log('');

function probeMcp() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [MCP_ENTRY, '--app', `http://127.0.0.1:${config.port}`], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NO_PROXY: '127.0.0.1,localhost' },
    });
    let buf = '';
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      child.kill();
      resolve(v);
    };
    child.stdout.on('data', (d) => {
      buf += d;
      for (const line of buf.split('\n')) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === 2 && msg.result?.tools) finish({ ok: true, tools: msg.result.tools.length });
        } catch {
          /* partial */
        }
      }
    });
    child.on('error', (e) => finish({ ok: false, error: e.message }));
    setTimeout(() => finish({ ok: false, error: 'no response within 15s' }), 15000).unref();
    for (const m of [
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'setup', version: '1' } },
      },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ]) {
      child.stdin.write(`${JSON.stringify(m)}\n`);
    }
  });
}
