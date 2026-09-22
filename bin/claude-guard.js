#!/usr/bin/env node

import { spawn, execSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProxyServer } from '../src/proxy.js';
import { loadConfig } from '../src/config.js';
import { GuardDB } from '../src/db.js';
import { notifyProxyStarted, startTrayIndicator } from '../src/notifier.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const shimsDir = path.resolve(projectRoot, 'shims');

const args = process.argv.slice(2);

function checkProxyAlive(host, port) {
  return new Promise(resolve => {
    const req = http.request({
      hostname: host,
      port: port,
      path: '/claude-guard/stats',
      method: 'GET',
      timeout: 300
    }, res => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.end();
  });
}

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
\x1b[1m\x1b[36mClaude-Guard\x1b[0m - Otimizador Ativo de Tokens, Loops e Relatórios para Claude Code & Desktop

\x1b[1mUSO:\x1b[0m
  claude-guard [opções do claude...]       (inicia o Claude Code CLI com proteção)
  claude-guard codex [opções...]          (inicia o Codex CLI com proteção)
  codex-guard [opções do codex...]        (inicia diretamente o Codex CLI com proteção)
  claude-guard report                     (gera relatório histórico completo do SQLite)
  claude-guard report --project <nome>    (filtra relatório por projeto específico)
  claude-guard report --today             (relatório do dia atual)
  claude-guard report --export [csv|json] (exporta dados do histórico)
  claude-guard report --clear             (limpa histórico do banco)
  claude-guard dashboard                  (abre o dashboard web em tempo real no navegador)
  claude-guard status                     (exibe estatísticas em tempo real do proxy)
  claude-guard proxy                      (inicia apenas o servidor proxy local)
  claude-guard tray                       (inicia o indicador na bandeja do sistema - Linux)
  claude-guard autostart [enable|disable] (ativa ou desativa o início automático com o sistema)
  claude-guard setup-desktop              (integra automaticamente ao Claude Desktop)
  claude-guard setup-codex-desktop        (integra automaticamente ao ChatGPT / Codex Desktop)
  claude-guard --help                     (exibe esta ajuda)

\x1b[1mCOMO FUNCIONA:\x1b[0m
  1. Proxy HTTP local (porta 48080) interceptando chamadas Anthropic & OpenAI.
  2. Shims no PATH (cat, git, find, npm) impedem despejo de logs excessivos no contexto.
  3. Poda contextualmente 'tool_results' de rodadas antigas e trunca saídas gigantes.
  4. Circuit Breaker contra loops agênticos (mais de 12 tool calls seguidas).
  5. Separação automática por projeto no banco SQLite (~/.config/claude-guard/history.db).
`);
  process.exit(0);
}

// ----------------------------------------------------
// COMMAND: report (Historical SQLite statistics)
// ----------------------------------------------------
if (args[0] === 'report') {
  const db = new GuardDB();

  if (args.includes('--clear')) {
    db.clearHistory();
    console.log('\x1b[32m✔ Histórico do banco de dados SQLite foi limpo com sucesso.\x1b[0m');
    db.close();
    process.exit(0);
  }

  // Parse --project filter
  let filterProject = null;
  const projectArgIdx = args.findIndex(a => a === '--project' || a === '-p');
  if (projectArgIdx !== -1 && args[projectArgIdx + 1]) {
    filterProject = args[projectArgIdx + 1];
  }

  const exportIdx = args.indexOf('--export');
  if (exportIdx !== -1) {
    const format = args[exportIdx + 1] === 'csv' ? 'csv' : 'json';
    console.log(db.exportData(format, filterProject));
    db.close();
    process.exit(0);
  }

  const overall = db.getOverallStats(filterProject);
  const daily = db.getDailyStats(14, filterProject);
  const projects = db.getProjectStats();
  const clients = db.getClientStats(filterProject);

  console.log('\n\x1b[36m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m');
  const title = filterProject
    ? `  Claude-Guard 🛡️  - Relatório do Projeto: \x1b[1m${filterProject}\x1b[0m`
    : `  Claude-Guard 🛡️  - Relatório Histórico de Economia (SQLite)`;
  console.log(`\x1b[1m\x1b[36m${title}\x1b[0m`);
  console.log('\x1b[36m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m');
  
  if (overall.totalRequests === 0) {
    if (filterProject) {
      console.log(`  Nenhuma requisição registrada para o projeto '${filterProject}'.`);
    } else {
      console.log('  Nenhuma requisição registrada ainda no banco de dados.');
    }
    console.log('  O histórico será gravado automaticamente conforme você usa o Claude Code ou Desktop.\n');
    db.close();
    process.exit(0);
  }

  console.log(`  Total de Requisições Interceptadas : \x1b[1m${overall.totalRequests.toLocaleString()}\x1b[0m`);
  console.log(`  Tokens Economizados Estimados      : \x1b[32m~${overall.totalSavedTokens.toLocaleString()}\x1b[0m (\x1b[1m${overall.reductionPercent}\x1b[0m de corte)`);
  console.log(`  Economia Financeira Estimada       : \x1b[32m\x1b[1m${overall.estimatedUsdSaved} USD\x1b[0m (ref: Claude 3.7 Sonnet)`);
  console.log(`  Saídas de Tools Truncadas          : \x1b[33m${overall.totalTruncated}\x1b[0m`);
  console.log(`  Turnos Antigos Compactados         : \x1b[33m${overall.totalPruned}\x1b[0m`);
  console.log(`  Loops Cegos Travados (Circuit)     : \x1b[31m${overall.totalLoopsBlocked}\x1b[0m`);
  console.log(`  Telemetrias Bloqueadas (Rede)      : \x1b[35m${overall.totalTelemetryBlocked}\x1b[0m requisições poupadas`);

  // Project Breakdown (only show when not already filtering by a single project)
  if (!filterProject && projects.length > 0) {
    console.log('\n\x1b[1m  Divisão por Projeto:\x1b[0m');
    console.log('  ' + 'Projeto'.padEnd(20) + 'Requisições'.padEnd(14) + 'Tokens Salvos'.padEnd(16) + 'Corte %'.padEnd(10) + 'Economia USD');
    console.log('  ' + '─'.repeat(70));
    for (const p of projects) {
      console.log(
        '  ' + 
        p.projectName.padEnd(20) + 
        String(p.requestCount).padEnd(14) + 
        `~${p.tokensSaved.toLocaleString()}`.padEnd(16) + 
        p.reductionPercent.padEnd(10) + 
        p.estimatedUsdSaved
      );
    }
  }

  console.log('\n\x1b[1m  Divisão por Origem:\x1b[0m');
  const clientLabels = {
    'desktop': 'Claude Desktop App',
    'cli': 'Claude Code CLI',
    'codex-cli': 'Codex CLI',
    'codex-desktop': 'Codex Desktop App'
  };
  for (const c of clients) {
    const name = clientLabels[c.client_type] || c.client_type;
    console.log(`    • ${name.padEnd(20)}: ${c.request_count} reqs | ~${Number(c.tokens_saved).toLocaleString()} tokens poupados`);
  }

  const telemetryBreakdown = db.getTelemetryStats();
  if (telemetryBreakdown.length > 0) {
    console.log('\n\x1b[1m\x1b[35m  Telemetrias Neutralizadas (0 bytes enviados ao upstream Anthropic):\x1b[0m');
    for (const t of telemetryBreakdown) {
      const bytesStr = t.total_bytes_saved > 0 ? `${t.total_bytes_saved} B descartados` : '0 B enviado';
      console.log(`    • \x1b[1m${t.method} ${t.endpoint.padEnd(18)}\x1b[0m: ${t.blocked_count}x bloqueado | Resposta: \x1b[32m200 OK (simulado)\x1b[0m | Upstream: \x1b[35mBloqueado (${bytesStr})\x1b[0m`);
    }
  }

  console.log('\n\x1b[1m  Evolução Diária:\x1b[0m');
  console.log('  ' + 'Data'.padEnd(12) + 'Requisições'.padEnd(14) + 'Tokens Salvos'.padEnd(16) + 'Corte %'.padEnd(10) + 'Economia USD'.padEnd(14) + 'Loops');
  console.log('  ' + '─'.repeat(70));
  
  const daysToShow = args.includes('--today') ? daily.slice(0, 1) : daily;
  for (const d of daysToShow) {
    console.log(
      '  ' + 
      d.date.padEnd(12) + 
      String(d.requests).padEnd(14) + 
      `~${d.tokensSaved.toLocaleString()}`.padEnd(16) + 
      d.reductionPercent.padEnd(10) + 
      d.estimatedUsdSaved.padEnd(14) +
      String(d.loopsPrevented)
    );
  }

  console.log('\x1b[36m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m\n');
  db.close();
  process.exit(0);
}

// ----------------------------------------------------
// COMMAND: status (Live daemon + Persistent summary)
// ----------------------------------------------------
else if (args[0] === 'status') {
  const config = loadConfig();
  const db = new GuardDB();
  const overall = db.getOverallStats();

  const req = http.request({
    hostname: config.host,
    port: config.port,
    path: '/claude-guard/stats',
    method: 'GET',
    timeout: 2000
  }, res => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      try {
        const json = JSON.parse(data);
        console.log('\n\x1b[32m✔ Claude-Guard Proxy está ATIVO\x1b[0m em http://' + config.host + ':' + config.port);
        console.log('\x1b[36m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m');
        console.log('\x1b[1m\x1b[36m  Sessão Atual em Execução\x1b[0m');
        console.log('\x1b[36m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m');
        const s = json.session;
        console.log(`  Projeto Atual             : \x1b[1m${json.currentProject || 'Geral'}\x1b[0m`);
        console.log(`  Requisições interceptadas : \x1b[1m${s.totalRequests}\x1b[0m`);
        console.log(`  Saídas de tools truncadas : \x1b[33m${s.truncatedToolResults}\x1b[0m`);
        console.log(`  Turnos antigos podados    : \x1b[33m${s.prunedToolResults}\x1b[0m`);
        console.log(`  Loops travados (circuit)  : \x1b[31m${s.circuitBreakerTriggered}\x1b[0m`);
        console.log(`  Telemetrias bloqueadas    : \x1b[35m${s.telemetryBlocked || 0}\x1b[0m requisições`);
        console.log(`  Tokens economizados (est.): \x1b[32m~${s.estimatedTokensSaved.toLocaleString()}\x1b[0m (${s.reductionPercent} de corte)`);
        
        console.log('\n\x1b[1m\x1b[36m  Acumulado Histórico (SQLite)\x1b[0m');
        console.log('\x1b[36m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m');
        console.log(`  Total Geral de Requisições: \x1b[1m${overall.totalRequests}\x1b[0m`);
        console.log(`  Telemetrias de Rede Bloq. : \x1b[35m${overall.totalTelemetryBlocked}\x1b[0m requisições poupadas`);
        console.log(`  Total de Tokens Poupados  : \x1b[32m~${overall.totalSavedTokens.toLocaleString()}\x1b[0m`);
        console.log(`  Economia Financeira Total : \x1b[32m\x1b[1m${overall.estimatedUsdSaved} USD\x1b[0m`);

        const tSummary = json.telemetrySummary || db.getTelemetryStats();
        if (Array.isArray(tSummary) && tSummary.length > 0) {
          console.log('\n\x1b[1m\x1b[35m  Endpoints de Telemetria Bloqueados (0B enviados à Anthropic):\x1b[0m');
          for (const t of tSummary) {
            const bytesStr = t.total_bytes_saved > 0 ? `${t.total_bytes_saved} B descartados` : '0 B enviado';
            console.log(`    • \x1b[1m${t.method} ${t.endpoint.padEnd(18)}\x1b[0m: ${t.blocked_count}x bloqueado | Resposta: \x1b[32m200 OK local\x1b[0m | Upstream: \x1b[35m0 B (${bytesStr})\x1b[0m`);
          }
        }
        console.log('\x1b[36m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m\n');
        db.close();
        process.exit(0);
      } catch (err) {
        console.error('Resposta inválida do proxy:', err.message);
        db.close();
        process.exit(1);
      }
    });
  });

  req.on('error', () => {
    console.log(`\x1b[33m● Claude-Guard Proxy está OFFLINE\x1b[0m (nenhum daemon em http://${config.host}:${config.port})`);
    if (overall.totalRequests > 0) {
      console.log('\n\x1b[1m\x1b[36m  Acumulado Histórico Gravado (SQLite):\x1b[0m');
      console.log(`  Requisições registradas   : ${overall.totalRequests}`);
      console.log(`  Tokens poupados no total  : ~${overall.totalSavedTokens.toLocaleString()}`);
      console.log(`  Economia estimada total   : ${overall.estimatedUsdSaved} USD`);
      console.log(`  Para ver relatório completo: \x1b[1mclaude-guard report\x1b[0m\n`);
    }
    db.close();
    process.exit(0);
  });
  req.end();
}

// ----------------------------------------------------
// COMMAND: dashboard / ui (Real-time web monitoring)
// ----------------------------------------------------
else if (args[0] === 'dashboard' || args[0] === 'ui') {
  const config = loadConfig();
  const dashboardUrl = `http://${config.host}:${config.port}/dashboard`;

  const openBrowser = (url) => {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    try {
      const child = spawn(opener, [url], { detached: true, stdio: 'ignore' });
      child.unref();
    } catch (e) {
      // ignore
    }
  };

  const checkReq = http.request({
    hostname: config.host,
    port: config.port,
    path: '/claude-guard/stats',
    method: 'GET',
    timeout: 1000
  }, res => {
    console.log(`\n\x1b[32m✔ Abrindo dashboard do Claude-Guard:\x1b[0m \x1b[1m\x1b[36m${dashboardUrl}\x1b[0m\n`);
    openBrowser(dashboardUrl);
    process.exit(0);
  });

  checkReq.on('error', () => {
    console.log(`\x1b[33m● Claude-Guard Proxy está OFFLINE.\x1b[0m`);
    console.log(`  Iniciando proxy em segundo plano na porta ${config.port}...`);

    const logFile = path.resolve(process.env.HOME || '.', '.config/Claude/claude-guard.log');
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
    } catch {}

    const out = fs.openSync(logFile, 'a');
    const err = fs.openSync(logFile, 'a');

    const nodeBin = process.execPath;
    const guardBin = path.resolve(projectRoot, 'bin/claude-guard.js');

    const child = spawn(nodeBin, [guardBin, 'proxy'], {
      detached: true,
      stdio: ['ignore', out, err]
    });
    child.unref();

    setTimeout(() => {
      console.log(`\x1b[32m✔ Proxy iniciado!\x1b[0m Abrindo dashboard: \x1b[1m\x1b[36m${dashboardUrl}\x1b[0m\n`);
      openBrowser(dashboardUrl);
      process.exit(0);
    }, 600);
  });

  checkReq.end();
}

// ----------------------------------------------------
// COMMAND: setup-desktop
// ----------------------------------------------------
else if (args[0] === 'setup-desktop') {
  const config = loadConfig();
  const launcherPath = path.resolve(process.env.HOME, '.local/bin/claude-desktop');
  if (!fs.existsSync(launcherPath)) {
    console.error(`\x1b[31mErro: Não foi encontrado o launcher do Claude Desktop em ${launcherPath}\x1b[0m`);
    process.exit(1);
  }

  const backupPath = `${launcherPath}.backup`;
  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(launcherPath, backupPath);
  }

  const script = `#!/usr/bin/env bash
# Claude-Guard Desktop Launcher

# Garante que o node esteja no PATH mesmo em inicialização gráfica (GNOME/KDE/desktop)
if ! command -v node >/dev/null 2>&1; then
  if [ -x "$HOME/.local/share/fnm/fnm" ]; then
    eval "$("$HOME/.local/share/fnm/fnm" env 2>/dev/null)"
  elif [ -s "$HOME/.nvm/nvm.sh" ]; then
    . "$HOME/.nvm/nvm.sh"
  elif [ -x "$HOME/.local/share/fnm/node-versions/v24.20.0/installation/bin/node" ]; then
    export PATH="$HOME/.local/share/fnm/node-versions/v24.20.0/installation/bin:$PATH"
  fi
fi

NODE_BIN=$(command -v node 2>/dev/null || echo "node")
SHIMS_DIR="${shimsDir}"
GUARD_BIN="${path.resolve(projectRoot, 'bin/claude-guard.js')}"
LOG_FILE="$HOME/.config/Claude/claude-guard.log"

# Inicia o proxy local em segundo plano se nao estiver ativo
if ! curl -s http://127.0.0.1:${config.port}/claude-guard/stats >/dev/null 2>&1; then
  mkdir -p "$HOME/.config/Claude"
  CLAUDE_GUARD_CLIENT=desktop nohup "$NODE_BIN" "$GUARD_BIN" proxy < /dev/null >> "$LOG_FILE" 2>&1 &
  sleep 0.4
fi

export ANTHROPIC_BASE_URL="http://127.0.0.1:${config.port}"
export PATH="$SHIMS_DIR:$PATH"

exec /usr/lib/claude-desktop/claude-desktop --ozone-platform=x11 "$@"
`;

  fs.writeFileSync(launcherPath, script, { mode: 0o755 });
  console.log(`\x1b[32m✔ Integração com o Claude Desktop concluída com sucesso!\x1b[0m`);
  console.log(`  Arquivo atualizado: ${launcherPath}`);
  console.log(`  Backup salvo em   : ${backupPath}`);
  console.log(`\nAgora, sempre que você abrir o Claude Desktop:`);
  console.log(`  • O proxy e o SQLite gravarão os dados automaticamente.`);
  console.log(`  • Relatórios por projeto disponíveis com: \x1b[1mclaude-guard report\x1b[0m\n`);
  process.exit(0);
}

// ----------------------------------------------------
// COMMAND: setup-codex-desktop
// ----------------------------------------------------
else if (args[0] === 'setup-codex-desktop') {
  const config = loadConfig();
  const localBinDir = path.resolve(process.env.HOME || '.', '.local/bin');
  const desktopAppsDir = path.resolve(process.env.HOME || '.', '.local/share/applications');
  fs.mkdirSync(localBinDir, { recursive: true });
  fs.mkdirSync(desktopAppsDir, { recursive: true });

  const chatgptLauncherPath = path.resolve(localBinDir, 'chatgpt');
  const desktopFilePath = path.resolve(desktopAppsDir, 'chatgpt.desktop');

  if (fs.existsSync(chatgptLauncherPath)) {
    const backupPath = `${chatgptLauncherPath}.backup`;
    if (!fs.existsSync(backupPath)) {
      try { fs.copyFileSync(chatgptLauncherPath, backupPath); } catch {}
    }
  }

  // Find real ChatGPT / Codex desktop binary
  let realBin = '/usr/lib/chatgpt/codex-launcher';
  if (!fs.existsSync(realBin)) {
    realBin = '/usr/bin/chatgpt';
  }

  const script = `#!/usr/bin/env bash
# Codex-Guard Desktop Launcher (ChatGPT Desktop)

# Garante que o node esteja no PATH
if ! command -v node >/dev/null 2>&1; then
  if [ -x "$HOME/.local/share/fnm/fnm" ]; then
    eval "$("$HOME/.local/share/fnm/fnm" env 2>/dev/null)"
  elif [ -s "$HOME/.nvm/nvm.sh" ]; then
    . "$HOME/.nvm/nvm.sh"
  elif [ -x "$HOME/.local/share/fnm/node-versions/v24.20.0/installation/bin/node" ]; then
    export PATH="$HOME/.local/share/fnm/node-versions/v24.20.0/installation/bin:$PATH"
  fi
fi

NODE_BIN=$(command -v node 2>/dev/null || echo "node")
SHIMS_DIR="${shimsDir}"
GUARD_BIN="${path.resolve(projectRoot, 'bin/claude-guard.js')}"
LOG_FILE="$HOME/.config/claude-guard/codex-desktop.log"

# Inicia o proxy local em segundo plano se nao estiver ativo
if ! curl -s http://127.0.0.1:${config.port}/claude-guard/stats >/dev/null 2>&1; then
  mkdir -p "$HOME/.config/claude-guard"
  CLAUDE_GUARD_CLIENT=codex-desktop nohup "$NODE_BIN" "$GUARD_BIN" proxy < /dev/null >> "$LOG_FILE" 2>&1 &
  sleep 0.4
fi

export PATH="$SHIMS_DIR:$PATH"
export OPENAI_BASE_URL="http://127.0.0.1:${config.port}"
export CODEX_API_BASE="$OPENAI_BASE_URL"
unset HTTP_PROXY HTTPS_PROXY ALL_PROXY all_proxy
export CLAUDE_GUARD_CLIENT="codex-desktop"
export DO_NOT_TRACK="1"
export DISABLE_TELEMETRY="1"

exec "${realBin}" "$@"
`;

  fs.writeFileSync(chatgptLauncherPath, script, { mode: 0o755 });

  const desktopEntry = `[Desktop Entry]
Name=ChatGPT (Codex-Guard)
Comment=ChatGPT & Codex Desktop com Proteção Ativa de Tokens e Shims
GenericName=AI assistant
Exec=${chatgptLauncherPath} %U
Icon=chatgpt
Type=Application
StartupNotify=true
Categories=Utility;Development;
MimeType=x-scheme-handler/codex;x-scheme-handler/http;x-scheme-handler/https;text/csv;application/vnd.openxmlformats-officedocument.wordprocessingml.document;application/vnd.openxmlformats-officedocument.presentationml.presentation;text/tab-separated-values;application/vnd.ms-excel;application/vnd.ms-excel.sheet.macroEnabled.12;application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;
`;

  fs.writeFileSync(desktopFilePath, desktopEntry, { mode: 0o644 });

  console.log(`\x1b[32m✔ Integração com o ChatGPT / Codex Desktop concluída com sucesso!\x1b[0m`);
  console.log(`  Launcher gerado: ${chatgptLauncherPath}`);
  console.log(`  Atalho Desktop : ${desktopFilePath}`);
  console.log(`\nAgora, ao abrir o ChatGPT / Codex Desktop:`);
  console.log(`  • O proxy e o SQLite gravarão os dados automaticamente.`);
  console.log(`  • Os shims (cat, git, find, npm) conterão desperdícios de contexto.`);
  console.log(`  • Relatórios disponíveis com: \x1b[1mclaude-guard report\x1b[0m\n`);
  process.exit(0);
}

// ----------------------------------------------------
// COMMAND: proxy (Standalone mode)
// ----------------------------------------------------
else if (args[0] === 'proxy') {
  const { server, config, optimizer, db } = createProxyServer();
  const dashboardUrl = `http://${config.host}:${config.port}/dashboard`;
  let trayProc = null;

  server.listen(config.port, config.host, () => {
    console.log(`\x1b[32m✔ Claude-Guard Proxy em execução em http://${config.host}:${config.port}\x1b[0m`);
    console.log(`  Dashboard Web: \x1b[1m\x1b[36m${dashboardUrl}\x1b[0m`);
    console.log(`  Banco SQLite : ~/.config/claude-guard/history.db`);
    console.log(`  Configure no shell: export ANTHROPIC_BASE_URL="http://${config.host}:${config.port}"`);

    // Notificação visual no desktop Linux
    notifyProxyStarted(config.port, dashboardUrl);

    // Iniciar indicador na bandeja se em ambiente gráfico e não desabilitado
    if (!args.includes('--no-tray')) {
      trayProc = startTrayIndicator(config.port, process.pid);
    }
  });

  server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\x1b[31m[claude-guard] Erro: A porta ${config.port} já está em uso!\x1b[0m`);
      console.error(`Defina outra porta com CLAUDE_GUARD_PORT=${config.port + 1} claude-guard proxy ou encerre o processo anterior.`);
    } else {
      console.error(`\x1b[31m[claude-guard] Erro no servidor:\x1b[0m`, err);
    }
    process.exit(1);
  });

  const cleanup = () => {
    console.log('\n\x1b[36m[claude-guard]\x1b[0m Encerrando proxy...');
    if (trayProc) {
      try { trayProc.kill(); } catch {}
    }
    console.table(optimizer.getSummary());
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

// ----------------------------------------------------
// COMMAND: tray (Linux System Tray Indicator)
// ----------------------------------------------------
else if (args[0] === 'tray') {
  const config = loadConfig();
  const trayScript = path.resolve(projectRoot, 'scripts/claude-guard-tray.py');
  if (!fs.existsSync(trayScript)) {
    console.error('\x1b[31mErro: Script do indicador de bandeja não encontrado.\x1b[0m');
    process.exit(1);
  }

  const child = spawn('python3', [trayScript, '--port', String(config.port)], {
    stdio: 'inherit'
  });

  child.on('close', code => {
    process.exit(code ?? 0);
  });
}

// ----------------------------------------------------
// COMMAND: autostart (systemd --user & XDG Autostart)
// ----------------------------------------------------
else if (args[0] === 'autostart') {
  const action = args[1] || 'status';
  const homeDir = process.env.HOME || '.';
  const systemdUserDir = path.resolve(homeDir, '.config/systemd/user');
  const serviceFile = path.resolve(systemdUserDir, 'claude-guard.service');
  const autostartDir = path.resolve(homeDir, '.config/autostart');
  const desktopFile = path.resolve(autostartDir, 'claude-guard.desktop');
  const guardBin = path.resolve(projectRoot, 'bin/claude-guard.js');
  const nodeBin = process.execPath;
  const config = loadConfig();

  if (action === 'enable' || action === '--enable') {
    fs.mkdirSync(systemdUserDir, { recursive: true });
    fs.mkdirSync(autostartDir, { recursive: true });

    const uid = typeof process.getuid === 'function' ? process.getuid() : 1000;
    const serviceContent = `[Unit]
Description=Claude-Guard & Codex-Guard Local Proxy and Token Optimizer
Documentation=https://github.com/mensonones/claude-guard
After=network.target

[Service]
Type=simple
ExecStart=${nodeBin} ${guardBin} proxy
Restart=always
RestartSec=3s
Environment=NODE_ENV=production
Environment=PATH=${path.dirname(nodeBin)}:/usr/local/bin:/usr/bin:/bin
Environment=CLAUDE_GUARD_PORT=${config.port}
Environment=DISPLAY=${process.env.DISPLAY || ':0'}
Environment=WAYLAND_DISPLAY=${process.env.WAYLAND_DISPLAY || 'wayland-0'}
Environment=DBUS_SESSION_BUS_ADDRESS=${process.env.DBUS_SESSION_BUS_ADDRESS || ''}
Environment=XDG_RUNTIME_DIR=${process.env.XDG_RUNTIME_DIR || `/run/user/${uid}`}

[Install]
WantedBy=default.target
`;
    fs.writeFileSync(serviceFile, serviceContent, 'utf-8');

    let systemdOk = false;
    try {
      execSync('systemctl --user daemon-reload', { stdio: 'ignore' });
      execSync('systemctl --user enable --now claude-guard.service', { stdio: 'ignore' });
      systemdOk = true;
    } catch {}

    if (systemdOk) {
      try { if (fs.existsSync(desktopFile)) fs.unlinkSync(desktopFile); } catch {}
    } else {
      const desktopContent = `[Desktop Entry]
Type=Application
Name=Claude-Guard
Comment=Proxy Local e Otimizador de Tokens para Claude Code & Codex
Exec=${nodeBin} ${guardBin} proxy
Terminal=false
Icon=security-high
Categories=Utility;Development;
X-GNOME-Autostart-enabled=true
`;
      fs.writeFileSync(desktopFile, desktopContent, 'utf-8');
    }

    console.log('\n\x1b[32m✔ Inicialização automática com o sistema configurada com sucesso!\x1b[0m');
    console.log(`  Porta padrão do serviço: \x1b[1m\x1b[36m${config.port}\x1b[0m`);
    if (systemdOk) {
      console.log(`  Serviço systemd: \x1b[32mhabilitado e ativo\x1b[0m (~/.config/systemd/user/claude-guard.service)`);
      console.log(`  Comandos úteis:`);
      console.log(`    • Logs do serviço   : \x1b[1mjournalctl --user -u claude-guard -f\x1b[0m`);
      console.log(`    • Status do serviço : \x1b[1msystemctl --user status claude-guard\x1b[0m`);
      console.log(`    • Reiniciar serviço : \x1b[1msystemctl --user restart claude-guard\x1b[0m`);
    }
    console.log(systemdOk
      ? '  Autostart ativo pelo systemd; entrada XDG não foi mantida para evitar dois proxies.\n'
      : '  Arquivo autostart: ~/.config/autostart/claude-guard.desktop\n');
    process.exit(0);
  } else if (action === 'disable' || action === '--disable') {
    try {
      execSync('systemctl --user stop claude-guard.service', { stdio: 'ignore' });
      execSync('systemctl --user disable claude-guard.service', { stdio: 'ignore' });
    } catch {}

    if (fs.existsSync(serviceFile)) {
      try { fs.unlinkSync(serviceFile); } catch {}
    }
    if (fs.existsSync(desktopFile)) {
      try { fs.unlinkSync(desktopFile); } catch {}
    }
    try {
      execSync('systemctl --user daemon-reload', { stdio: 'ignore' });
    } catch {}

    console.log('\n\x1b[32m✔ Inicialização automática desativada com sucesso.\x1b[0m\n');
    process.exit(0);
  } else {
    console.log('\n\x1b[36m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m');
    console.log('  \x1b[1m\x1b[36mClaude-Guard - Status de Autostart no Sistema\x1b[0m');
    console.log('\x1b[36m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m');
    let systemdActive = 'inativo';
    let systemdEnabled = 'desabilitado';
    try {
      const activeOut = execSync('systemctl --user is-active claude-guard.service 2>/dev/null', { encoding: 'utf-8' }).trim();
      systemdActive = activeOut === 'active' ? '\x1b[32mativo (running)\x1b[0m' : activeOut;
    } catch {}
    try {
      const enabledOut = execSync('systemctl --user is-enabled claude-guard.service 2>/dev/null', { encoding: 'utf-8' }).trim();
      systemdEnabled = enabledOut === 'enabled' ? '\x1b[32mhabilitado\x1b[0m' : enabledOut;
    } catch {}

    const hasDesktop = fs.existsSync(desktopFile);

    console.log(`  Serviço systemd : ${systemdEnabled} / ${systemdActive}`);
    console.log(`  Arquivo Desktop : ${hasDesktop ? '\x1b[32mpresente\x1b[0m (~/.config/autostart/claude-guard.desktop)' : 'ausente'}`);
    console.log(`  Porta padrão    : \x1b[1m${config.port}\x1b[0m`);
    console.log('\x1b[36m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m');
    console.log(`  Para ativar  : \x1b[1mclaude-guard autostart enable\x1b[0m`);
    console.log(`  Para remover : \x1b[1mclaude-guard autostart disable\x1b[0m\n`);
    process.exit(0);
  }
}

// ----------------------------------------------------
// COMMAND: codex (CLI wrapper mode)
// ----------------------------------------------------
else if (args[0] === 'codex') {
  const codexArgs = args.slice(1);
  const config = loadConfig();
  const cwd = process.cwd();
  const projectName = path.basename(cwd) || 'Geral';

  let codexBin = process.env.CODEX_BIN;
  if (!codexBin) {
    const candidates = [
      path.resolve(process.env.HOME || '.', '.local/bin/codex'),
      '/usr/lib/chatgpt/resources/codex',
      'codex'
    ];
    for (const cand of candidates) {
      if (fs.existsSync(cand)) {
        codexBin = cand;
        break;
      }
    }
    codexBin = codexBin || 'codex';
  }

  const env = { ...process.env };
  // Keep Codex on a cleartext local API base so the proxy can inspect JSON.
  // HTTPS_PROXY would create a blind CONNECT tunnel and bypass the dashboard.
  env.OPENAI_BASE_URL = env.OPENAI_BASE_URL || `http://${config.host}:${config.port}`;
  env.CODEX_API_BASE = env.CODEX_API_BASE || env.OPENAI_BASE_URL;
  delete env.HTTP_PROXY;
  delete env.HTTPS_PROXY;
  delete env.ALL_PROXY;
  delete env.all_proxy;
  env.CLAUDE_GUARD_CLIENT = 'codex-cli';
  env.CLAUDE_GUARD_PROJECT = projectName;
  env.CLAUDE_GUARD_PROJECT_PATH = cwd;
  env.DO_NOT_TRACK = '1';
  env.DISABLE_TELEMETRY = '1';
  if (config.enableShims) {
    env.PATH = `${shimsDir}:${env.PATH}`;
  }

  const finalArgs = [...codexArgs];
  if (!finalArgs.includes('respect_system_proxy') && !finalArgs.some(a => a.includes('respect_system_proxy'))) {
    finalArgs.unshift('--enable', 'respect_system_proxy');
  }

  const isAlreadyRunning = await checkProxyAlive(config.host, config.port);
  if (isAlreadyRunning) {
    console.log(`\x1b[32m✔ Codex-Guard conectado ao Proxy ativo na porta ${config.port}\x1b[0m [Projeto: \x1b[1m${projectName}\x1b[0m]`);

    const codexProc = spawn(codexBin, finalArgs, {
      env,
      stdio: 'inherit'
    });

    codexProc.on('close', code => {
      const db = new GuardDB();
      const overall = db.getOverallStats(projectName);
      console.log('\n\x1b[36m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m');
      console.log(`\x1b[1m\x1b[36m  Codex-Guard - Balanço da Sessão [${projectName}]\x1b[0m`);
      console.log('\x1b[36m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m');
      console.log(`  Economia Total no Projeto : \x1b[32m\x1b[1m${overall.estimatedUsdSaved} USD\x1b[0m (~${overall.totalSavedTokens.toLocaleString()} tokens)`);
      console.log('  Consulte o histórico com: \x1b[1mclaude-guard report\x1b[0m\n');
      db.close();
      process.exit(code ?? 0);
    });

    codexProc.on('error', err => {
      console.error(`\x1b[31m[claude-guard] Erro ao iniciar 'codex':\x1b[0m ${err.message}`);
      process.exit(1);
    });

    process.on('SIGINT', () => {});
  } else {
    const { server, optimizer, db } = createProxyServer({
      ...config,
      clientType: 'codex-cli',
      projectName,
      projectPath: cwd
    });

    server.listen(config.port, config.host, () => {
      console.log(`\x1b[32m✔ Codex-Guard ativado na porta ${config.port}\x1b[0m [Projeto: \x1b[1m${projectName}\x1b[0m]`);
      notifyProxyStarted(config.port, `http://${config.host}:${config.port}/dashboard`);

      const codexProc = spawn(codexBin, finalArgs, {
        env,
        stdio: 'inherit'
      });

      const finish = (code = 0) => {
        console.log('\n\x1b[36m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m');
        console.log(`\x1b[1m\x1b[36m  Codex-Guard - Balanço da Sessão [${projectName}]\x1b[0m`);
        console.log('\x1b[36m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m');
        const summary = optimizer.getSummary();
        console.log(`  Requisições interceptadas : \x1b[1m${summary.totalRequests}\x1b[0m`);
        console.log(`  Saídas de tools truncadas : \x1b[33m${summary.truncatedToolResults}\x1b[0m`);
        console.log(`  Turnos antigos podados    : \x1b[33m${summary.prunedToolResults}\x1b[0m`);
        console.log(`  Loops travados (anti-loop): \x1b[31m${summary.circuitBreakerTriggered}\x1b[0m`);
        console.log(`  Tokens economizados (est.): \x1b[32m~${summary.estimatedTokensSaved.toLocaleString()}\x1b[0m (${summary.reductionPercent} de corte)`);
        
        const overall = db.getOverallStats(projectName);
        console.log(`  Economia Total no Projeto : \x1b[32m\x1b[1m${overall.estimatedUsdSaved} USD\x1b[0m (~${overall.totalSavedTokens.toLocaleString()} tokens)`);
        console.log('\x1b[36m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m');
        console.log('  Consulte o histórico com: \x1b[1mclaude-guard report\x1b[0m\n');
        
        server.close(() => {
          db.close();
          process.exit(code);
        });
      };

      codexProc.on('close', code => {
        finish(code ?? 0);
      });

      codexProc.on('error', err => {
        console.error(`\x1b[31m[claude-guard] Erro ao iniciar 'codex':\x1b[0m ${err.message}`);
        finish(1);
      });

      process.on('SIGINT', () => {});
    });

    server.on('error', err => {
      if (err.code === 'EADDRINUSE') {
        console.error(`\x1b[31m[claude-guard] Erro: A porta ${config.port} já está em uso!\x1b[0m`);
        console.error(`Defina outra porta com CLAUDE_GUARD_PORT=${config.port + 1} claude-guard codex ou encerre o processo anterior.`);
      } else {
        console.error(`\x1b[31m[claude-guard] Erro no servidor:\x1b[0m`, err);
      }
      process.exit(1);
    });
  }
}

// ----------------------------------------------------
// COMMAND: Integrated CLI wrapper mode (default: claude)
// ----------------------------------------------------
else {
  const config = loadConfig();
  const cwd = process.cwd();
  const projectName = path.basename(cwd) || 'Geral';

  const env = { ...process.env };
  env.ANTHROPIC_BASE_URL = `http://${config.host}:${config.port}`;
  env.CLAUDE_GUARD_CLIENT = 'cli';
  env.CLAUDE_GUARD_PROJECT = projectName;
  env.CLAUDE_GUARD_PROJECT_PATH = cwd;
  env.CLAUDE_CODE_ENABLE_TELEMETRY = '0';
  env.OTEL_SDK_DISABLED = 'true';
  env.DO_NOT_TRACK = '1';
  env.DISABLE_TELEMETRY = '1';
  env.DISABLE_AUTOUPDATER = '1';
  if (config.enableShims) {
    env.PATH = `${shimsDir}:${env.PATH}`;
  }

  const isAlreadyRunning = await checkProxyAlive(config.host, config.port);
  if (isAlreadyRunning) {
    console.log(`\x1b[32m✔ Claude-Guard conectado ao Proxy ativo na porta ${config.port}\x1b[0m [Projeto: \x1b[1m${projectName}\x1b[0m]`);

    const claudeProc = spawn('claude', args, {
      env,
      stdio: 'inherit'
    });

    claudeProc.on('close', code => {
      const db = new GuardDB();
      const overall = db.getOverallStats(projectName);
      console.log('\n\x1b[36m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m');
      console.log(`\x1b[1m\x1b[36m  Claude-Guard - Balanço da Sessão [${projectName}]\x1b[0m`);
      console.log('\x1b[36m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m');
      console.log(`  Economia Total no Projeto : \x1b[32m\x1b[1m${overall.estimatedUsdSaved} USD\x1b[0m (~${overall.totalSavedTokens.toLocaleString()} tokens)`);
      console.log('  Consulte o histórico com: \x1b[1mclaude-guard report\x1b[0m\n');
      db.close();
      process.exit(code ?? 0);
    });

    claudeProc.on('error', err => {
      console.error(`\x1b[31m[claude-guard] Erro ao iniciar 'claude':\x1b[0m ${err.message}`);
      process.exit(1);
    });

    process.on('SIGINT', () => {});
  } else {
    const { server, optimizer, db } = createProxyServer({
      ...config,
      clientType: 'cli',
      projectName,
      projectPath: cwd
    });

    server.listen(config.port, config.host, () => {
      console.log(`\x1b[32m✔ Claude-Guard ativado na porta ${config.port}\x1b[0m [Projeto: \x1b[1m${projectName}\x1b[0m]`);
      notifyProxyStarted(config.port, `http://${config.host}:${config.port}/dashboard`);

      const claudeProc = spawn('claude', args, {
        env,
        stdio: 'inherit'
      });

      const finish = (code = 0) => {
        console.log('\n\x1b[36m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m');
        console.log(`\x1b[1m\x1b[36m  Claude-Guard - Balanço da Sessão [${projectName}]\x1b[0m`);
        console.log('\x1b[36m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m');
        const summary = optimizer.getSummary();
        console.log(`  Requisições interceptadas : \x1b[1m${summary.totalRequests}\x1b[0m`);
        console.log(`  Saídas de tools truncadas : \x1b[33m${summary.truncatedToolResults}\x1b[0m`);
        console.log(`  Turnos antigos podados    : \x1b[33m${summary.prunedToolResults}\x1b[0m`);
        console.log(`  Loops travados (anti-loop): \x1b[31m${summary.circuitBreakerTriggered}\x1b[0m`);
        console.log(`  Tokens economizados (est.): \x1b[32m~${summary.estimatedTokensSaved.toLocaleString()}\x1b[0m (${summary.reductionPercent} de corte)`);
        
        const overall = db.getOverallStats(projectName);
        console.log(`  Economia Total no Projeto : \x1b[32m\x1b[1m${overall.estimatedUsdSaved} USD\x1b[0m (~${overall.totalSavedTokens.toLocaleString()} tokens)`);
        console.log('\x1b[36m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m');
        console.log('  Consulte o histórico com: \x1b[1mclaude-guard report\x1b[0m\n');
        
        server.close(() => {
          db.close();
          process.exit(code);
        });
      };

      claudeProc.on('close', code => {
        finish(code ?? 0);
      });

      claudeProc.on('error', err => {
        console.error(`\x1b[31m[claude-guard] Erro ao iniciar 'claude':\x1b[0m ${err.message}`);
        finish(1);
      });

      process.on('SIGINT', () => {});
    });

    server.on('error', err => {
      if (err.code === 'EADDRINUSE') {
        console.error(`\x1b[31m[claude-guard] Erro: A porta ${config.port} já está em uso!\x1b[0m`);
        console.error(`Defina outra porta com CLAUDE_GUARD_PORT=${config.port + 1} claude-guard ou encerre o processo anterior.`);
      } else {
        console.error(`\x1b[31m[claude-guard] Erro no servidor:\x1b[0m`, err);
      }
      process.exit(1);
    });
  }
}
