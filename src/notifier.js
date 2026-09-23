import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const lastNotificationAt = new Map();

/**
 * Sends a native desktop notification on Linux via notify-send.
 * Silently catches errors if running in headless or unsupported environments.
 */
export function sendNotification({
  title = 'Claude-Codex-Guard',
  message = '',
  icon = 'security-high',
  urgency = 'normal',
  appName = 'Claude-Codex-Guard'
} = {}) {
  // Only attempt if not explicitly disabled and on linux / graphical display
  if (process.env.CLAUDE_CODEX_GUARD_NO_NOTIFY === '1') return;
  if (process.platform !== 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return;

  try {
    const child = spawn('notify-send', [
      '-a', appName,
      '-i', icon,
      '-u', urgency,
      '-h', 'string:desktop-entry:claude-codex-guard',
      title,
      message
    ], {
      detached: true,
      stdio: 'ignore'
    });
    child.on('error', () => {});
    child.unref();
  } catch {
    // Non-blocking, ignore
  }
}

/**
 * Notifies the desktop user that the proxy is online.
 */
export function notifyProxyStarted(port, dashboardUrl) {
  sendNotification({
    title: 'Claude-Codex-Guard Ativo 🛡️',
    message: `Proxy operando na porta ${port}\nDashboard: ${dashboardUrl}\nCompatível com Claude & Codex`,
    icon: 'security-high',
    urgency: 'normal'
  });
}

/**
 * Notifies the desktop user that a runaway agentic loop was stopped by Circuit Breaker.
 */
export function notifyCircuitBreaker(projectName, loops) {
  const key = String(projectName || 'Geral');
  const now = Date.now();
  if (now - (lastNotificationAt.get(key) || 0) < 30_000) return;
  lastNotificationAt.set(key, now);
  sendNotification({
    title: 'Claude-Codex-Guard: Circuit Breaker ⚠️',
    message: `Loop agêntico contido (${loops} passos de ferramentas seguidas) no projeto '${projectName}'.`,
    icon: 'dialog-warning',
    urgency: 'critical'
  });
}

/**
 * Starts the Python-based StatusNotifierItem tray indicator if available.
 */
export function startTrayIndicator(port, parentPid = process.pid) {
  if (process.env.CLAUDE_CODEX_GUARD_NO_TRAY === '1') return null;
  if (process.platform !== 'linux') return null;

  const trayScript = path.resolve(projectRoot, 'scripts/claude-codex-guard-tray.py');
  if (!fs.existsSync(trayScript)) return null;

  const uid = typeof process.getuid === 'function' ? process.getuid() : 1000;
  const rawDbus = process.env.DBUS_SESSION_BUS_ADDRESS || `unix:path=/run/user/${uid}/bus`;
  const cleanDbus = rawDbus.replace(/,guid=[a-f0-9]+/gi, '');

  const env = {
    ...process.env,
    DISPLAY: process.env.DISPLAY || ':0',
    WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY || 'wayland-0',
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${uid}`,
    DBUS_SESSION_BUS_ADDRESS: cleanDbus
  };

  let child = null;
  let retryCount = 0;
  let isShuttingDown = false;

  const launch = () => {
    if (isShuttingDown) return;
    try {
      child = spawn('python3', [
        trayScript,
        '--port', String(port),
        '--parent-pid', String(parentPid)
      ], {
        detached: true,
        env,
        stdio: ['ignore', 'inherit', 'inherit']
      });

      child.on('error', err => {
        console.warn(`[claude-codex-guard] Aviso: Indicador de bandeja não pôde ser iniciado: ${err.message}`);
      });

      child.on('exit', (code, signal) => {
        child = null;
        if (isShuttingDown || code === 0 || signal === 'SIGTERM' || signal === 'SIGINT') return;
        if (retryCount < 5) {
          retryCount++;
          const delay = Math.min(retryCount * 2000, 10000);
          setTimeout(launch, delay).unref();
        }
      });

      child.unref();
    } catch {
      // Ignorado se python3 não estiver disponível
    }
  };

  launch();

  return {
    kill: (sig = 'SIGTERM') => {
      isShuttingDown = true;
      if (child) {
        try { child.kill(sig); } catch {}
      }
    }
  };
}
