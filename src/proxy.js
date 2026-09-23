import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { TokenOptimizer } from './optimizer.js';
import { GuardDB } from './db.js';
import { detectProjectFromPayload } from './projectDetector.js';
import { notifyCircuitBreaker } from './notifier.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DASHBOARD_HTML_PATH = path.join(__dirname, 'dashboard.html');
const packageJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf-8'));

const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 10000,
  timeout: 300000
});

const httpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 10000,
  timeout: 300000
});

/**
 * Classifies a request without relying on the process that started the proxy.
 * This matters when Claude and Codex share one long-lived proxy daemon.
 */
export function detectClientType(url = '/', headers = {}, fallback = 'desktop') {
  const explicit = headers['x-claude-codex-guard-client'] || headers['x-codex-client'] || headers['x-client-type'];
  if (explicit) return String(explicit).toLowerCase();

  const normalizedUrl = String(url).toLowerCase();
  const userAgent = String(headers['user-agent'] || '').toLowerCase();
  if (/chatgpt|codex[-_ ]?desktop/.test(userAgent) ||
      /codex[-_ ]?desktop|chatgpt/i.test(String(headers.originator || ''))) return 'codex-desktop';
  const isCodex = normalizedUrl.includes('/backend-api/') ||
    normalizedUrl.includes('/chat/completions') ||
    normalizedUrl.includes('/responses') ||
    userAgent.includes('codex') ||
    userAgent.includes('chatgpt');
  if (!isCodex) return fallback;
  return String(fallback).toLowerCase().includes('codex') ? fallback : 'codex-cli';
}

/**
 * Determines the target host, port, and path for an incoming request.
 * Accurately differentiates Anthropic vs OpenAI vs Codex upstreams.
 */
export function detectTarget(url = '/', req = null, config = {}, requestClientType = 'desktop') {
  const headers = req?.headers || {};
  let targetHost = config.targetHost || 'api.anthropic.com';
  let targetPort = config.targetPort || 443;
  let targetPath = url;

  if (url.startsWith('http://') || url.startsWith('https://')) {
    try {
      const parsed = new URL(url);
      targetHost = parsed.hostname;
      targetPort = parsed.port ? parseInt(parsed.port, 10) : (parsed.protocol === 'https:' ? 443 : 80);
      targetPath = parsed.pathname + parsed.search;
      return { targetHost, targetPort, targetPath };
    } catch {}
  }

  if (headers['x-target-host']) {
    targetHost = headers['x-target-host'];
    targetPort = headers['x-target-port'] ? parseInt(headers['x-target-port'], 10) : 443;
    return { targetHost, targetPort, targetPath };
  }

  const normalizedUrl = String(url).toLowerCase();
  const userAgent = String(headers['user-agent'] || '').toLowerCase();
  const clientType = String(requestClientType || '').toLowerCase();
  const authHeader = String(headers['authorization'] || '');

  // Codex Backend API is always routed to codexTargetHost (chatgpt.com)
  if (normalizedUrl.includes('/backend-api/')) {
    return {
      targetHost: config.codexTargetHost || 'chatgpt.com',
      targetPort: config.codexTargetPort || 443,
      targetPath
    };
  }

  // Explicit OpenAI endpoints
  if (normalizedUrl.includes('/chat/completions') || normalizedUrl.includes('/responses')) {
    return {
      targetHost: config.openaiTargetHost || 'api.openai.com',
      targetPort: config.openaiTargetPort || 443,
      targetPath
    };
  }

  // Anthropic indicators
  const isAnthropic =
    Boolean(headers['anthropic-version']) ||
    Boolean(headers['anthropic-beta']) ||
    Boolean(headers['x-api-key']) ||
    authHeader.startsWith('Bearer sk-ant-') ||
    userAgent.includes('anthropic') ||
    userAgent.includes('claude') ||
    clientType.includes('claude') ||
    clientType === 'desktop' ||
    normalizedUrl.includes('/messages') ||
    normalizedUrl.includes('/complete') ||
    normalizedUrl === '/api/hello';

  // OpenAI / Codex indicators
  const isOpenAI =
    Boolean(headers['openai-organization']) ||
    Boolean(headers['openai-project']) ||
    Boolean(headers['x-codex-client']) ||
    clientType.includes('codex') ||
    userAgent.includes('openai') ||
    userAgent.includes('codex') ||
    userAgent.includes('chatgpt') ||
    authHeader.startsWith('Bearer sk-proj-');

  if (normalizedUrl.startsWith('/v1/models')) {
    if (isOpenAI && !isAnthropic) {
      return {
        targetHost: config.openaiTargetHost || 'api.openai.com',
        targetPort: config.openaiTargetPort || 443,
        targetPath
      };
    }
    // Default to Anthropic for /v1/models (supports Claude Code and Claude Desktop OAuth)
    return {
      targetHost: config.targetHost || 'api.anthropic.com',
      targetPort: config.targetPort || 443,
      targetPath
    };
  }

  if (isOpenAI) {
    return {
      targetHost: config.openaiTargetHost || 'api.openai.com',
      targetPort: config.openaiTargetPort || 443,
      targetPath
    };
  }

  return {
    targetHost: config.targetHost || 'api.anthropic.com',
    targetPort: config.targetPort || 443,
    targetPath
  };
}

export function createProxyServer(userConfig = {}) {
  const config = { ...loadConfig(), ...userConfig };
  const optimizer = new TokenOptimizer(config);
  const db = new GuardDB(userConfig.dbPath || null);
  const clientType = userConfig.clientType || process.env.CLAUDE_CODEX_GUARD_CLIENT || 'desktop';
  let currentProject = userConfig.projectName || process.env.CLAUDE_CODEX_GUARD_PROJECT || 'Geral';
  let currentProjectPath = userConfig.projectPath || process.env.CLAUDE_CODEX_GUARD_PROJECT_PATH || null;
  const sseClients = new Set();

  function broadcastEvent(eventType, payload) {
    if (sseClients.size === 0) return;
    const msg = `event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const clientRes of sseClients) {
      try {
        clientRes.write(msg);
      } catch {
        sseClients.delete(clientRes);
      }
    }
  }

  const sessionUuids = new Map();
  const defaultSessionUuid = db.createSession(clientType, currentProject, currentProjectPath);
  sessionUuids.set(clientType, defaultSessionUuid);

  function getRequestClientType(url, req = null) {
    // A request may come from a shared proxy process. Prefer the explicit
    // per-client header so Claude Desktop and Codex Desktop do not get merged
    // into the process owner's session.
    return detectClientType(url, req?.headers || {}, clientType);
  }

  const sessionProjects = new Map();

  function getSessionUuid(requestClientType, headers = {}) {
    const sourceId = headers.session_id || headers['x-codex-session-id'] || headers['x-session-id'];
    const key = sourceId ? JSON.stringify([requestClientType, sourceId]) : requestClientType;
    if (!sessionUuids.has(key)) {
      sessionUuids.set(key, db.createSession(requestClientType, currentProject, currentProjectPath));
    }
    return sessionUuids.get(key);
  }

  const server = http.createServer((req, res) => {
    const url = req.url || '/';
    const method = req.method || 'GET';
    const requestClientType = getRequestClientType(url, req);
    const requestSessionUuid = getSessionUuid(requestClientType, req.headers);
    let { projectName: currentProject, projectPath: currentProjectPath } =
      sessionProjects.get(requestSessionUuid) || {
        projectName: userConfig.projectName || process.env.CLAUDE_CODEX_GUARD_PROJECT || 'Geral',
        projectPath: userConfig.projectPath || process.env.CLAUDE_CODEX_GUARD_PROJECT_PATH || null
      };

    const pathname = url.split('?')[0];

    // Register desktop clients as soon as their launcher opens, before the first LLM request.
    if (method === 'POST' && pathname === '/claude-codex-guard/register') {
      const registeredClientType = req.headers['x-claude-codex-guard-client'] ||
        req.headers['x-codex-client'] || 'desktop';
      const registeredProject = req.headers['x-claude-codex-guard-project'] || currentProject;
      const registeredProjectPath = req.headers['x-claude-codex-guard-project-path'] || currentProjectPath;
      const registeredSessionUuid = db.createSession(registeredClientType, registeredProject, registeredProjectPath);
      sessionUuids.set(registeredClientType, registeredSessionUuid);
      sessionProjects.set(registeredSessionUuid, { projectName: registeredProject, projectPath: registeredProjectPath });
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ registered: true, clientType: registeredClientType }));
      return;
    }

    // Handle CORS preflight OPTIONS requests locally
    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': req.headers.origin || '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS, HEAD, PATCH',
        'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] || '*',
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Max-Age': '86400',
        'Content-Length': '0'
      });
      res.end();
      return;
    }

    // Serve real-time Web Dashboard
    if ((method === 'GET' || method === 'HEAD') && (pathname === '/' || pathname === '/dashboard')) {
      try {
        const html = fs.readFileSync(DASHBOARD_HTML_PATH, 'utf-8');
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': Buffer.byteLength(html)
        });
        if (method === 'HEAD') {
          res.end();
        } else {
          res.end(html);
        }
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Erro ao carregar o dashboard: ' + err.message);
      }
      return;
    }

    // Recent requests endpoint for dashboard hydration
    if (method === 'GET' && url === '/claude-codex-guard/recent') {
      res.writeHead(200, {
        'Content-Type': 'application/json'
      });
      try {
        const recent = db.getRecentRequests(40);
        res.end(JSON.stringify(recent));
      } catch (err) {
        res.end(JSON.stringify([]));
      }
      return;
    }

    // Server-Sent Events (SSE) stream for real-time live events
    if (method === 'GET' && url === '/claude-codex-guard/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });
      res.write(': connected\n\n');
      sseClients.add(res);

      req.on('close', () => {
        sseClients.delete(res);
      });
      return;
    }

    // Telemetry details endpoint (stats + recent logs)
    if (method === 'GET' && url === '/claude-codex-guard/telemetry') {
      res.writeHead(200, {
        'Content-Type': 'application/json'
      });
      try {
        res.end(JSON.stringify({
          summary: db.getTelemetryStats(),
          recent: db.getRecentTelemetryBlocks(50)
        }));
      } catch (err) {
        res.end(JSON.stringify({ summary: [], recent: [] }));
      }
      return;
    }

    // Sessions list endpoint for dashboard hydration
    if (method === 'GET' && url === '/claude-codex-guard/sessions') {
      res.writeHead(200, {
        'Content-Type': 'application/json'
      });
      try {
        res.end(JSON.stringify(db.getRecentSessions(25)));
      } catch (err) {
        res.end(JSON.stringify([]));
      }
      return;
    }

    // Local health, live session and SQLite persistent stats endpoint
    if (url === '/claude-codex-guard/stats' || url === '/_guard/stats') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        status: 'online',
        version: packageJson.version,
        port: config.port,
        currentProject,
        session: optimizer.getSummary(),
        allTime: db.getOverallStats(),
        projects: db.getProjectStats(),
        clients: db.getClientStats(),
        sessions: db.getRecentSessions(15),
        telemetrySummary: db.getTelemetryStats()
      }, null, 2));
      return;
    }

    // Intercept and block telemetry/tracking calls (saves network bandwidth & latency)
    const isTelemetry = 
      url.startsWith('/v1/metrics') ||
      url.startsWith('/v1/traces') ||
      url.startsWith('/v1/logs') ||
      url.includes('/telemetry') ||
      url.includes('/analytics') ||
      url.includes('/statsig') ||
      url.includes('/sentry') ||
      url.includes('/datadog');

    if (isTelemetry) {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        const payloadBytes = Buffer.concat(chunks).length || parseInt(req.headers['content-length'] || '0', 10) || 0;
        optimizer.stats.telemetryBlocked = (optimizer.stats.telemetryBlocked || 0) + 1;

        db.logTelemetryBlock({
          sessionUuid: requestSessionUuid,
          projectName: currentProject,
          endpoint: url,
          method,
          bytesPrevented: payloadBytes,
          statusCode: 200
        });

        console.log(`\x1b[35m[claude-codex-guard]\x1b[0m 🛡️ Telemetria bloqueada: \x1b[1m${method} ${url}\x1b[0m (0B enviados para Anthropic / ${payloadBytes}B descartados localmente)`);

        broadcastEvent('telemetry', {
          type: 'telemetry',
          endpoint: url,
          method,
          bytesPrevented: payloadBytes,
          upstreamBlocked: true,
          statusReturned: 200,
          timestamp: new Date().toLocaleTimeString('pt-BR')
        });

        res.writeHead(200, {
          'content-type': 'application/json',
          'x-claude-codex-guard-blocked': 'true',
          'x-claude-codex-guard-upstream': 'aborted-locally'
        });
        res.end(JSON.stringify({
          status: 'ok',
          blocked_by: 'claude-codex-guard',
          upstream_forwarded: false,
          endpoint: url,
          bytes_prevented: payloadBytes,
          message: 'Telemetry discarded locally by Claude-Codex-Guard proxy (0 bytes sent upstream)'
        }));
      });
      return;
    }

    // Determine upstream target (Anthropic vs OpenAI vs custom)
    const { targetHost, targetPort, targetPath } = detectTarget(url, req, config, requestClientType);

    // Clone headers
    const forwardedHeaders = { ...req.headers };
    forwardedHeaders['host'] = targetPort && ![80, 443].includes(Number(targetPort))
      ? `${targetHost}:${targetPort}`
      : targetHost;
    delete forwardedHeaders['x-target-host'];
    delete forwardedHeaders['x-target-port'];
    // These are local routing hints and must never be sent to a provider.
    delete forwardedHeaders['x-claude-codex-guard-client'];
    delete forwardedHeaders['x-codex-client'];
    delete forwardedHeaders['x-client-type'];

    // Strip local origins to prevent upstream Cloudflare from rejecting with "Disallowed CORS origin"
    if (forwardedHeaders['origin'] && /localhost|127\.0\.0\.1|vscode-file|file:\/\//.test(forwardedHeaders['origin'])) {
      delete forwardedHeaders['origin'];
    }
    if (forwardedHeaders['referer'] && /localhost|127\.0\.0\.1/.test(forwardedHeaders['referer'])) {
      delete forwardedHeaders['referer'];
    }

    function prepareResponseHeaders(upstreamHeaders) {
      const respHeaders = { ...upstreamHeaders };
      if (req.headers.origin) {
        respHeaders['access-control-allow-origin'] = req.headers.origin;
        respHeaders['access-control-allow-credentials'] = 'true';
      }
      return respHeaders;
    }

    // Optimize LLM messages (Anthropic /v1/messages or OpenAI /v1/chat/completions, /v1/responses)
    const isOptimizable =
      method === 'POST' && (
        url.includes('/messages') ||
        url.includes('/chat/completions') ||
        url.includes('/responses') ||
        url.includes('/backend-api/')
      );

    if (isOptimizable) {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        let rawBody = Buffer.concat(chunks).toString('utf-8');
        let requestBody = rawBody;
        const originalLen = rawBody.length;
        let optimizedLen = originalLen;
        let model = 'unknown';

        try {
          const jsonPayload = JSON.parse(rawBody);
          model = jsonPayload.model || 'unknown';

          // Detect project from payload context
          const detected = detectProjectFromPayload(jsonPayload);
          if (detected.projectName && detected.projectName !== 'Geral') {
            currentProject = detected.projectName;
            currentProjectPath = detected.projectPath;
            db.updateSessionProject(requestSessionUuid, currentProject, currentProjectPath);
            sessionProjects.set(requestSessionUuid, detected);
          }

          const formatHint = (url.includes('/chat/completions') || url.includes('/responses') || url.includes('/backend-api/')) ? 'openai' : 'anthropic';
          const result = optimizer.optimize(jsonPayload, formatHint);

          if (result.modified) {
            requestBody = JSON.stringify(result.payload);
            optimizedLen = requestBody.length;
            const savedTokens = result.savedTokens;
            const totalSaved = result.stats.estimatedTokensSaved;
            
            console.log(
              `\x1b[36m[claude-codex-guard]\x1b[0m ⚡ [\x1b[1m${currentProject}\x1b[0m] Req #${result.stats.totalRequests}: Poupatron economizou \x1b[32m~${savedTokens.toLocaleString()} tokens\x1b[0m | Sessão: \x1b[32m~${totalSaved.toLocaleString()} tokens\x1b[0m`
            );

            if (result.circuitBreakerActivated) {
              console.log(
                `\x1b[33m[claude-codex-guard]\x1b[0m ⚠️  \x1b[1mCIRCUIT BREAKER ATIVADO:\x1b[0m Limite de loops atingido (${config.maxConsecutiveToolCalls}). Agente foi instruído a parar e reportar.`
              );
              notifyCircuitBreaker(currentProject, config.maxConsecutiveToolCalls);
            }
          } else {
            console.log(`\x1b[36m[claude-codex-guard]\x1b[0m → [\x1b[1m${currentProject}\x1b[0m] Req #${result.stats.totalRequests}: Direta (sem corte necessário)`);
          }

          // Persist to SQLite with project association
          try {
            db.logRequest({
              sessionUuid: requestSessionUuid,
              projectName: currentProject,
              model,
              originalChars: originalLen,
              optimizedChars: optimizedLen,
              savedChars: Math.max(0, originalLen - optimizedLen),
              savedTokens: result.savedTokens,
              truncatedCount: result.stats.truncatedToolResults,
              prunedCount: result.stats.prunedToolResults,
              circuitBreaker: result.circuitBreakerActivated ? 1 : 0
            });
          } catch (dbErr) {
            console.error('[claude-codex-guard] Failed to log request to SQLite:', dbErr.message);
          }

          // Broadcast real-time event to connected dashboard clients
          broadcastEvent('request', {
            type: 'request',
            project: currentProject,
            clientType: requestClientType,
            model,
            savedTokens: result.savedTokens,
            origChars: originalLen,
            optChars: optimizedLen,
            circuitBreaker: !!result.circuitBreakerActivated,
            timestamp: new Date().toLocaleTimeString('pt-BR')
          });

        } catch (err) {
          console.warn('[claude-codex-guard] Failed to parse JSON body, passing through:', err.message);
        }

        const bodyBuffer = Buffer.from(requestBody, 'utf-8');
        delete forwardedHeaders['transfer-encoding'];
        forwardedHeaders['content-length'] = Buffer.byteLength(bodyBuffer);

        const targetOptions = {
          hostname: targetHost,
          port: targetPort,
          path: targetPath,
          method: method,
          headers: forwardedHeaders,
          agent: targetPort === 443 ? httpsAgent : httpAgent
        };

        const clientReq = (targetPort === 443 ? https : http).request(targetOptions, targetRes => {
          res.writeHead(targetRes.statusCode || 200, prepareResponseHeaders(targetRes.headers));
          targetRes.pipe(res);
        });

        res.on('close', () => {
          if (!res.writableFinished && !clientReq.destroyed) clientReq.destroy();
        });

        clientReq.on('error', err => {
          console.error('[claude-codex-guard] Forwarding error:', err.message);
          if (!res.headersSent) {
            res.writeHead(502, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: `Proxy error to ${targetHost}`, message: err.message }));
          }
        });

        clientReq.write(bodyBuffer);
        clientReq.end();
      });
    } else {
      const targetOptions = {
        hostname: targetHost,
        port: targetPort,
        path: targetPath,
        method: method,
        headers: forwardedHeaders,
        agent: targetPort === 443 ? httpsAgent : httpAgent
      };

      const clientReq = (targetPort === 443 ? https : http).request(targetOptions, targetRes => {
        res.writeHead(targetRes.statusCode || 200, prepareResponseHeaders(targetRes.headers));
        targetRes.pipe(res);
      });

      res.on('close', () => {
        if (!res.writableFinished && !clientReq.destroyed) clientReq.destroy();
      });

      clientReq.on('error', err => {
        console.error('[claude-codex-guard] Forwarding error:', err.message);
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: `Proxy error to ${targetHost}`, message: err.message }));
        }
      });

      req.pipe(clientReq);
    }
  });

  // Handle CONNECT method for HTTPS tunneling
  server.on('connect', (req, clientSocket, head) => {
    const parts = req.url.split(':');
    const host = parts[0];
    const port = parseInt(parts[1] || '443', 10);

    const serverSocket = net.connect(port, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length > 0) {
        serverSocket.write(head);
      }
      serverSocket.pipe(clientSocket);
      clientSocket.pipe(serverSocket);
    });

    serverSocket.on('error', () => {
      clientSocket.destroy();
    });
    clientSocket.on('error', () => {
      serverSocket.destroy();
    });
  });

  return { server, config, optimizer, db, broadcastEvent, sseClients };
}

// Allow direct execution
if (process.argv[1] && process.argv[1].endsWith('proxy.js')) {
  const { server, config, optimizer, db } = createProxyServer();
  server.listen(config.port, config.host, () => {
    console.log(`\x1b[32m✔ Claude-Codex-Guard Proxy ativo em http://${config.host}:${config.port}\x1b[0m`);
    console.log(`  Alvo: https://${config.targetHost}:${config.targetPort}`);
    console.log(`  SQLite persistente: ~/.config/claude-codex-guard/history.db`);
    console.log(`  Max tool chars: ${config.maxToolResultChars} | Keep recent turns: ${config.keepRecentToolTurns} | Max loops: ${config.maxConsecutiveToolCalls}\n`);
  });

  const cleanup = () => {
    console.log('\n\x1b[36m[claude-codex-guard]\x1b[0m Resumo da Sessão:');
    console.table(optimizer.getSummary());
    console.log('\x1b[36m[claude-codex-guard]\x1b[0m Acumulado no SQLite:');
    console.table(db.getOverallStats());
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => {
      try { db.close(); } catch {}
      process.exit(0);
    }, 1500).unref();
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}
