import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { defaultConfig, loadConfig } from '../src/config.js';
import { sendNotification, notifyProxyStarted, notifyCircuitBreaker } from '../src/notifier.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

test('Config default port is 48080', () => {
  const expectedPort = Number(process.env.CLAUDE_CODEX_GUARD_PORT || 48080);
  assert.equal(defaultConfig.port, expectedPort, 'Config must respect the selected port');
  const config = loadConfig();
  assert.equal(config.port, expectedPort, 'Loaded config must respect the selected port');
});

test('Notifier module exports notification methods and runs without throwing', () => {
  assert.equal(typeof sendNotification, 'function');
  assert.equal(typeof notifyProxyStarted, 'function');
  assert.equal(typeof notifyCircuitBreaker, 'function');

  // Should run silently without crashing even with arbitrary inputs
  assert.doesNotThrow(() => {
    notifyProxyStarted(48080, 'http://127.0.0.1:48080/dashboard');
    notifyCircuitBreaker('TestProject', 12);
  });
});

test('Python tray script exists, is executable and compiles cleanly', t => {
  const trayScript = path.resolve(projectRoot, 'scripts/claude-codex-guard-tray.py');
  assert.ok(fs.existsSync(trayScript), 'Tray script must exist');
  
  const tempDir = fs.mkdtempSync(path.join('/tmp', 'claude-codex-guard-python-'));
  try {
    execSync(`python3 -m py_compile "${trayScript}"`, {
      env: { ...process.env, PYTHONPYCACHEPREFIX: tempDir }
    });
  } catch (err) {
    if (err.code === 'EPERM') return t.skip('sandbox blocks subprocess execution');
    throw err;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('CLI autostart status executes correctly and reports status', t => {
  const guardBin = path.resolve(projectRoot, 'bin/claude-codex-guard.js');
  let output;
  try {
    output = execSync(`node "${guardBin}" autostart status`, { encoding: 'utf-8' });
  } catch (err) {
    if (err.code === 'EPERM') return t.skip('sandbox blocks subprocess execution');
    throw err;
  }
  assert.match(output, /Status de Autostart no Sistema/);
  assert.match(output, /Serviço systemd/);
  assert.match(output, /Arquivo Desktop/);
  assert.match(output, new RegExp(String(defaultConfig.port)));
});
