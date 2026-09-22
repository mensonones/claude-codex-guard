#!/usr/bin/env node

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const claudeGuardBin = path.resolve(__dirname, 'claude-guard.js');

const rawArgs = process.argv.slice(2);

// Handle subcommands
let forwardedArgs = [];
if (rawArgs[0] === 'setup-desktop') {
  forwardedArgs = ['setup-codex-desktop', ...rawArgs.slice(1)];
} else if (rawArgs[0] === 'report' || rawArgs[0] === 'dashboard' || rawArgs[0] === 'ui' || rawArgs[0] === 'status' || rawArgs[0] === 'proxy' || rawArgs[0] === 'autostart' || rawArgs[0] === 'tray') {
  forwardedArgs = [...rawArgs];
} else if (rawArgs.includes('--help') || rawArgs.includes('-h')) {
  console.log(`
\x1b[1m\x1b[36mCodex-Guard\x1b[0m - Otimizador Ativo de Tokens e Interceptador de Loops para OpenAI Codex & Desktop

\x1b[1mUSO:\x1b[0m
  codex-guard [opções do codex...]        (inicia o Codex CLI com proteção)
  codex-guard setup-desktop               (integra automaticamente ao ChatGPT / Codex Desktop)
  codex-guard report                      (gera relatório histórico completo do SQLite)
  codex-guard report --project <nome>     (filtra relatório por projeto específico)
  codex-guard report --today              (relatório do dia atual)
  codex-guard report --export [csv|json]  (exporta dados do histórico)
  codex-guard dashboard                   (abre o dashboard web em tempo real no navegador)
  codex-guard status                      (exibe estatísticas em tempo real do proxy)
  codex-guard proxy                       (inicia apenas o servidor proxy local)
  codex-guard tray                        (inicia indicador na bandeja do sistema - Linux)
  codex-guard autostart [enable|disable]  (ativa ou desativa o início automático com o sistema)
  codex-guard --help                      (exibe esta ajuda)
`);
  process.exit(0);
} else {
  // Default: run codex wrapper
  forwardedArgs = ['codex', ...rawArgs];
}

const child = spawn(process.execPath, [claudeGuardBin, ...forwardedArgs], {
  stdio: 'inherit'
});

child.on('close', code => {
  process.exit(code ?? 0);
});
