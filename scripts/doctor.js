#!/usr/bin/env node
/**
 * Checks every link in the chain and prints the exact configuration to paste.
 *
 *   npm run doctor
 *
 * Exists so setup is never guesswork: it tells you which brain you're on,
 * whether that brain can actually answer, whether the MCP server works, and
 * what to give Claude Desktop and ChatGPT.
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

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

let failures = 0;
let warnings = 0;

const ok = (label, detail = '') => console.log(`  ${green('✓')} ${label}${detail ? dim(`  ${detail}`) : ''}`);
const warn = (label, detail = '') => {
  warnings++;
  console.log(`  ${yellow('!')} ${label}${detail ? dim(`  ${detail}`) : ''}`);
};
const bad = (label, detail = '') => {
  failures++;
  console.log(`  ${red('✗')} ${label}${detail ? dim(`  ${detail}`) : ''}`);
};

console.log(`\n${bold(`${config.brainName} — setup check`)}\n`);

// ── 1. environment ───────────────────────────────────────────────────────────

const major = Number(process.versions.node.split('.')[0]);
if (major >= 20) ok('Node', `v${process.versions.node}`);
else bad('Node', `v${process.versions.node} — needs 20 or newer`);

if (fs.existsSync(path.join(ROOT, 'node_modules'))) ok('Dependencies installed');
else bad('Dependencies missing', 'run: npm install');

if (fs.existsSync(path.join(ROOT, '.env'))) ok('.env present');
else warn('.env not found', 'cp .env.example .env');

// ── 2. the brain ─────────────────────────────────────────────────────────────

const status = providerStatus();
console.log(`\n${bold('Brain')}  ${dim(`(BRAIN_PROVIDER=${status.provider})`)}`);

if (status.provider === 'claude-code') {
  let cliOk = false;
  try {
    const { stdout } = await execFileAsync('claude', ['--version'], { timeout: 20000 });
    ok('Claude Code installed', stdout.trim());
    cliOk = true;
  } catch {
    bad('Claude Code not found', 'npm install -g @anthropic-ai/claude-code');
  }

  if (cliOk) {
    const probeMsg = '  … checking your subscription login (this makes one small request)';
    process.stdout.write(dim(probeMsg));
    try {
      const { stdout } = await execFileAsync('claude', ['-p', 'Reply with exactly: OK', '--output-format', 'json'], {
        timeout: 120000,
        maxBuffer: 10 * 1024 * 1024,
      });
      process.stdout.write(`\r${' '.repeat(probeMsg.length)}\r`);
      const res = JSON.parse(stdout);
      if (res.is_error) bad('Claude Code signed in but errored', String(res.result).slice(0, 120));
      else ok('Signed in and answering', 'running on your Claude subscription');
    } catch (err) {
      process.stdout.write(`\r${' '.repeat(probeMsg.length)}\r`);
      bad('Claude Code cannot answer', 'run `claude` once and sign in with your Pro/Max plan');
      console.log(dim(`      ${String(err.message).split('\n')[0].slice(0, 160)}`));
    }
  }
} else if (status.provider === 'anthropic') {
  if (config.anthropic.apiKey) ok('ANTHROPIC_API_KEY set', `model ${config.anthropic.model}`);
  else bad('ANTHROPIC_API_KEY missing', 'add it to .env, or use BRAIN_PROVIDER=claude-code for your Max plan');
} else {
  if (config.openai.apiKey) ok('OPENAI_API_KEY set', `model ${config.openai.model}`);
  else bad('OPENAI_API_KEY missing', 'add it to .env — note ChatGPT Plus does not include API access');
}

if (config.openai.apiKey) ok('OpenAI key present', 'semantic embeddings + high-quality voice');
else warn('No OpenAI key', 'recall falls back to lexical matching; browser voice only');

// ── 3. the app ───────────────────────────────────────────────────────────────

console.log(`\n${bold('App')}`);
const appUrl = `http://127.0.0.1:${config.port}`;
let appRunning = false;
try {
  const res = await fetch(`${appUrl}/api/health`, { signal: AbortSignal.timeout(4000) });
  const health = await res.json();
  ok('Server running', `${appUrl} · ${health.nodes} memories, ${health.edges} links`);
  appRunning = true;
} catch {
  warn('Server not running', 'start it with: npm run serve');
}

// ── 4. the MCP bridge ────────────────────────────────────────────────────────

console.log(`\n${bold('MCP bridge')}  ${dim('(how a Claude or ChatGPT subscription drives the graph)')}`);

const mcpEntry = path.join(ROOT, 'mcp', 'server.js');
const handshake = await probeMcp(mcpEntry, appUrl);
if (handshake.ok) ok('MCP server responds', `${handshake.tools} tools`);
else bad('MCP server failed', handshake.error);

// ── 5. what to paste ─────────────────────────────────────────────────────────

console.log(`\n${bold('Connect Claude (Pro/Max)')}`);
console.log(dim('  Claude Code — run this once, from anywhere:'));
console.log(`      claude mcp add second-brain -- node ${JSON.stringify(mcpEntry)}`);
console.log(dim('\n  Claude Desktop — Settings → Developer → Edit Config:'));
console.log(
  JSON.stringify({ mcpServers: { 'second-brain': { command: 'node', args: [mcpEntry] } } }, null, 2)
    .split('\n')
    .map((l) => `      ${l}`)
    .join('\n'),
);

console.log(`\n${bold('Connect ChatGPT (Plus/Pro)')}`);
console.log(dim('  Start the HTTP bridge (prints a token; set MCP_TOKEN to keep it stable):'));
console.log('      npm run mcp:http');
console.log(dim('  ChatGPT needs to reach it, so from a laptop expose it with a tunnel:'));
console.log(`      cloudflared tunnel --url http://localhost:${config.port === 8788 ? 8789 : 8788}`);
console.log(dim('  Then ChatGPT → Settings → Connectors → Advanced → Developer mode → add'));
console.log(dim('  the tunnel URL + /mcp, with the token as the bearer value.'));

// ── verdict ──────────────────────────────────────────────────────────────────

console.log('');
if (failures) {
  console.log(`${red(`${failures} problem${failures > 1 ? 's' : ''} to fix`)}${warnings ? dim(`, ${warnings} warning${warnings > 1 ? 's' : ''}`) : ''}\n`);
  process.exit(1);
}
if (!appRunning) {
  console.log(`${yellow('Ready — start the app with `npm run serve`')}\n`);
  process.exit(0);
}
console.log(`${green('Everything checks out.')}${warnings ? dim(`  (${warnings} warning${warnings > 1 ? 's' : ''})`) : ''}\n`);

// ── helpers ──────────────────────────────────────────────────────────────────

function probeMcp(entry, app) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entry, '--app', app], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NO_PROXY: '127.0.0.1,localhost' },
    });
    let buf = '';
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      child.kill();
      resolve(value);
    };
    child.stdout.on('data', (d) => {
      buf += d;
      for (const line of buf.split('\n')) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === 2 && msg.result?.tools) finish({ ok: true, tools: msg.result.tools.length });
        } catch {
          /* partial line */
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
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'doctor', version: '1' } },
      },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ]) {
      child.stdin.write(`${JSON.stringify(m)}\n`);
    }
  });
}
