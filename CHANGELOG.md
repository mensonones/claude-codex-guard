# Changelog

## 1.3.2 — 2026-09-22

- Corrigida a identificação de sessões Codex quando o proxy já está compartilhado com Claude Desktop.
- Requisições `/backend-api/`, Responses e Chat Completions agora são associadas ao cliente Codex por requisição.
- Adicionado teste de regressão para garantir que as requisições Codex apareçam no resumo de clientes da dashboard.
- Validada a captura real do Codex CLI com resposta `OK` e persistência no SQLite.

## 1.3.1 — 2026-09-22

- Adicionado instalador global idempotente com `claude-guard install` e `claude-guard update`.
- Detecção automática de Claude CLI/Code, Codex CLI, Claude Desktop e ChatGPT/Codex Desktop.
- Estado da instalação salvo em `~/.config/claude-guard/installation.json` para atualizar a versão global quando a origem mudar.
- Integrações desktop detectadas podem ser reconfiguradas automaticamente, mantendo backups dos launchers existentes.
- Suporte ao endpoint `chatgpt.com/backend-api/` usado pelo Codex instalado no ambiente local.

## 1.3.0 — 2026-09-22

- Corrigida a captura do Codex na dashboard usando `OPENAI_BASE_URL` e `CODEX_API_BASE` locais.
- Adicionado suporte real à otimização de itens `function_call_output` da OpenAI Responses API.
- Resultados paralelos do mesmo turno do Codex agora são preservados corretamente.
- Helpers opcionais de notificação e bandeja não interrompem o proxy quando indisponíveis.
- Autostart passou a escolher um único proprietário do proxy entre systemd e XDG.
- Testes de sistema ficaram isolados de configuração ambiente e artefatos Python temporários.

## 1.2.0 — 2026-09-22

- Nova porta padrão **`48080`**: dedicada e livre de conflitos com portas comuns de desenvolvimento local (8080, 8081, 3000, 5000).
- Notificações nativas no desktop Linux via **`notify-send`** ao iniciar o proxy e ao conter loops agênticos.
- Indicador integrado na **bandeja do sistema (System Tray)** via DBus `StatusNotifierItem` compatível com GNOME Shell, Wayland e KDE (`claude-guard tray`).
- Gerenciador de inicialização automática junto ao sistema operacional via **`systemd --user`** e **XDG Autostart** (`claude-guard autostart enable|disable|status`).
- Suporte nativo ao **OpenAI Codex CLI** (`codex-guard` e `claude-guard codex`).
- Suporte nativo ao **Codex Desktop / ChatGPT Desktop** (`claude-guard setup-codex-desktop` e `codex-guard setup-desktop`).
- Otimizador de tokens multi-provedor (`src/optimizer.js`): poda histórica de contexto, truncamento cirúrgico e circuit breaker para payloads no padrão OpenAI (`role: 'tool'`).
- Detecção automática de projetos (`src/projectDetector.js`) estendida para prompts e tool arguments da OpenAI.
- Proxy dinâmico multi-upstream (`src/proxy.js`) com roteamento automático para Anthropic ou OpenAI e suporte a HTTPS CONNECT tunneling.
- Reconexão automática e transparente a instâncias existentes do proxy local sem erros de porta em uso.
- Captura do Codex corrigida via `OPENAI_BASE_URL` local, com eventos persistidos no SQLite e enviados ao feed SSE da dashboard.
- Suporte efetivo a `function_call_output` da Responses API e preservação de resultados paralelos do mesmo turno.
- Falhas de `notify-send`/bandeja deixaram de interromper o proxy; notificações do circuit breaker passaram a ter cooldown.

## 1.1.0 — 2026-09-22

- Redesign da dashboard para um cockpit claro, premium e orientado à operação.
- Novo feed de atividade, resumo de saúde, telemetria, projetos e painel lateral de auditoria.
- Horários da dashboard normalizados para `America/Sao_Paulo`.
- Favicon substituído por um ícone SVG neutro, sem emoji.
- Conteúdo dinâmico da dashboard escapado antes da renderização.
- Atualização de métricas em tempo real com coalescência para reduzir repaints desnecessários.
- CORS aberto removido das rotas de observabilidade do proxy local.
- Documentação revisada para refletir os comandos e o layout atuais.
