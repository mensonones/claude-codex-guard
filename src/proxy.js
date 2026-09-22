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

export function createProxyServer(userConfig = {}) {
  const config = { ...loadConfig(), ...userConfig };
  const optimizer = new TokenOptimizer(config);
  const db = new GuardDB(userConfig.dbPath || null);
  const clientType = process.env.CLAUDE_GUARD_CLIENT || userConfig.clientType || 'desktop';
  let currentProject = userConfig.projectName || process.env.CLAUDE_GUARD_PROJECT || 'Geral';
  let currentProjectPath = userConfig.projectPath || process.env.CLAUDE_GUARD_PROJECT_PATH || null;
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

  function getRequestClientType(url) {
    if (url.includes('/backend-api/') || url.includes('/chat/completions') || url.includes('/responses')) {
      return clientType.includes('codex') ? clientType : 'codex-cli';
    }
    return clientType;
  }

  function getSessionUuid(requestClientType) {
    if (!sessionUuids.has(requestClientType)) {
      sessionUuids.set(requestClientType, db.createSession(requestClientType, currentProject, currentProjectPath));
    }
    return sessionUuids.get(requestClientType);
  }

  const server = http.createServer((req, res) => {
    const url = req.url || '/';
    const method = req.method || 'GET';
    const requestClientType = getRequestClientType(url);
    const requestSessionUuid = getSessionUuid(requestClientType);

    const pathname = url.split('?')[0];

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
    if (method === 'GET' && url === '/claude-guard/recent') {
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
    if (method === 'GET' && url === '/claude-guard/events') {
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
    if (method === 'GET' && url === '/claude-guard/telemetry') {
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

    // Local health, live session and SQLite persistent stats endpoint
    if (url === '/claude-guard/stats' || url === '/_guard/stats') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        status: 'online',
        port: config.port,
        currentProject,
        session: optimizer.getSummary(),
        allTime: db.getOverallStats(),
        projects: db.getProjectStats(),
        clients: db.getClientStats(),
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

        console.log(`\x1b[35m[claude-guard]\x1b[0m 🛡️ Telemetria bloqueada: \x1b[1m${method} ${url}\x1b[0m (0B enviados para Anthropic / ${payloadBytes}B descartados localmente)`);

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
          'x-claude-guard-blocked': 'true',
          'x-claude-guard-upstream': 'aborted-locally'
        });
        res.end(JSON.stringify({
          status: 'ok',
          blocked_by: 'claude-guard',
          upstream_forwarded: false,
          endpoint: url,
          bytes_prevented: payloadBytes,
          message: 'Telemetry discarded locally by Claude-Guard proxy (0 bytes sent upstream)'
        }));
      });
      return;
    }

    // Determine upstream target (Anthropic vs OpenAI vs custom)
    let targetHost = config.targetHost;
    let targetPort = config.targetPort;
    let targetPath = url;

    // Check if absolute URL (e.g. from standard HTTP_PROXY client)
    if (url.startsWith('http://') || url.startsWith('https://')) {
      try {
        const parsed = new URL(url);
        targetHost = parsed.hostname;
        targetPort = parsed.port ? parseInt(parsed.port, 10) : (parsed.protocol === 'https:' ? 443 : 80);
        targetPath = parsed.pathname + parsed.search;
      } catch {}
    } else {
      // Relative URL: detect if OpenAI/Codex vs Anthropic
      const isOpenAIEndpoint =
        url.includes('/chat/completions') ||
        url.includes('/responses') ||
        url.includes('/backend-api/') ||
        (url.startsWith('/v1/models') && !req.headers['x-api-key']);

      if (isOpenAIEndpoint) {
        if (url.includes('/backend-api/')) {
          targetHost = config.codexTargetHost;
          targetPort = config.codexTargetPort;
        } else {
          targetHost = config.openaiTargetHost;
          targetPort = config.openaiTargetPort;
        }
      } else if (req.headers['x-target-host']) {
        targetHost = req.headers['x-target-host'];
      }
    }

    // Clone headers
    const forwardedHeaders = { ...req.headers };
    forwardedHeaders['host'] = targetHost;
    delete forwardedHeaders['x-target-host'];

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
          }

          const formatHint = (url.includes('/chat/completions') || url.includes('/responses') || url.includes('/backend-api/')) ? 'openai' : 'anthropic';
          const result = optimizer.optimize(jsonPayload, formatHint);

          if (result.modified) {
            requestBody = JSON.stringify(result.payload);
            optimizedLen = requestBody.length;
            const savedTokens = result.savedTokens;
            const totalSaved = result.stats.estimatedTokensSaved;
            
            console.log(
              `\x1b[36m[claude-guard]\x1b[0m ⚡ [\x1b[1m${currentProject}\x1b[0m] Req #${result.stats.totalRequests}: Poupatron economizou \x1b[32m~${savedTokens.toLocaleString()} tokens\x1b[0m | Sessão: \x1b[32m~${totalSaved.toLocaleString()} tokens\x1b[0m`
            );

            if (result.circuitBreakerActivated) {
              console.log(
                `\x1b[33m[claude-guard]\x1b[0m ⚠️  \x1b[1mCIRCUIT BREAKER ATIVADO:\x1b[0m Limite de loops atingido (${config.maxConsecutiveToolCalls}). Agente foi instruído a parar e reportar.`
              );
              notifyCircuitBreaker(currentProject, config.maxConsecutiveToolCalls);
            }
          } else {
            console.log(`\x1b[36m[claude-guard]\x1b[0m → [\x1b[1m${currentProject}\x1b[0m] Req #${result.stats.totalRequests}: Direta (sem corte necessário)`);
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
            console.error('[claude-guard] Failed to log request to SQLite:', dbErr.message);
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
          console.warn('[claude-guard] Failed to parse JSON body, passing through:', err.message);
        }

        const bodyBuffer = Buffer.from(requestBody, 'utf-8');
        delete forwardedHeaders['transfer-encoding'];
        forwardedHeaders['content-length'] = Buffer.byteLength(bodyBuffer);

        const targetOptions = {
          hostname: targetHost,
          port: targetPort,
          path: targetPath,
          method: method,
          headers: forwardedHeaders
        };

        const clientReq = (targetPort === 443 ? https : http).request(targetOptions, targetRes => {
          res.writeHead(targetRes.statusCode || 200, targetRes.headers);
          targetRes.pipe(res);
        });

        clientReq.on('error', err => {
          console.error('[claude-guard] Forwarding error:', err.message);
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
        headers: forwardedHeaders
      };

      const clientReq = (targetPort === 443 ? https : http).request(targetOptions, targetRes => {
        res.writeHead(targetRes.statusCode || 200, targetRes.headers);
        targetRes.pipe(res);
      });

      clientReq.on('error', err => {
        console.error('[claude-guard] Forwarding error:', err.message);
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
    console.log(`\x1b[32m✔ Claude-Guard Proxy ativo em http://${config.host}:${config.port}\x1b[0m`);
    console.log(`  Alvo: https://${config.targetHost}:${config.targetPort}`);
    console.log(`  SQLite persistente: ~/.config/claude-guard/history.db`);
    console.log(`  Max tool chars: ${config.maxToolResultChars} | Keep recent turns: ${config.keepRecentToolTurns} | Max loops: ${config.maxConsecutiveToolCalls}\n`);
  });

  const cleanup = () => {
    console.log('\n\x1b[36m[claude-guard]\x1b[0m Resumo da Sessão:');
    console.table(optimizer.getSummary());
    console.log('\x1b[36m[claude-guard]\x1b[0m Acumulado no SQLite:');
    console.table(db.getOverallStats());
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}
