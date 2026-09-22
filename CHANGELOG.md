# Changelog

## Não lançado

- Renomeado o pacote e comando principal para `claude-codex-guard`, incluindo arquivos, configuração, variáveis de ambiente, endpoints, headers, provider, serviço e identidade visual.
- Mantido `codex-guard` como atalho dedicado ao Codex.
- Corrigido o roteamento de `/v1/models` para requisições Anthropic sob OAuth/Bearer token (Claude Code e Claude Desktop), impedindo que fossem incorretamente direcionadas para a API da OpenAI.
- Implementado tratamento local de preflight CORS (`OPTIONS`) com HTTP 204 e cabeçalhos `Access-Control-*`, eliminando bloqueios por navegadores e webviews Electron.
- Sanitização de cabeçalhos locais `Origin` e `Referer` antes do envio upstream para prevenir erros `Disallowed CORS origin` do Cloudflare.
- Corrigido encerramento prematuro de requisições GET upstream (`res.on('close')` em vez de `req.on('close')`).
- Preservação completa das configurações de plugins, marketplaces e ferramentas locais (`node_repl`) no `config.toml` do Codex Desktop.


## [1.3.4] - 2026-09-22

- Roteamento e identificação de clientes passaram a ser agnósticos ao processo que iniciou o proxy, separando Claude e Codex quando compartilham um daemon.
- Headers internos de identificação não são mais encaminhados aos provedores.
- Launchers desktop agora detectam caminhos reais disponíveis, não sobrescrevem binários do sistema e suportam instalações fora dos caminhos Linux originais.
- Documentação esclarece a limitação de aplicativos desktop que ignoram bases de API configuráveis.

## 1.3.3 — 2026-09-22

- Sessões do Codex Desktop agora são registradas na abertura do launcher, antes do primeiro prompt.
- A dashboard passou a exibir agentes sem requisições, evitando o estado vazio durante a inicialização.
- Adicionado endpoint local de registro de sessão e teste de regressão para o fluxo Codex Desktop.

## 1.3.2 — 2026-09-22

- Corrigida a identificação de sessões Codex quando o proxy já está compartilhado com Claude Desktop.
- Requisições `/backend-api/`, Responses e Chat Completions agora são associadas ao cliente Codex por requisição.
- Adicionado teste de regressão para garantir que as requisições Codex apareçam no resumo de clientes da dashboard.
- Validada a captura real do Codex CLI com resposta `OK` e persistência no SQLite.

## 1.3.1 — 2026-09-22

- Adicionado instalador global idempotente com `claude-codex-guard install` e `claude-codex-guard update`.
- Detecção automática de Claude CLI/Code, Codex CLI, Claude Desktop e ChatGPT/Codex Desktop.
- Estado da instalação salvo em `~/.config/claude-codex-guard/installation.json` para atualizar a versão global quando a origem mudar.
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
- Indicador integrado na **bandeja do sistema (System Tray)** via DBus `StatusNotifierItem` compatível com GNOME Shell, Wayland e KDE (`claude-codex-guard tray`).
- Gerenciador de inicialização automática junto ao sistema operacional via **`systemd --user`** e **XDG Autostart** (`claude-codex-guard autostart enable|disable|status`).
- Suporte nativo ao **OpenAI Codex CLI** (`codex-guard` e `claude-codex-guard codex`).
- Suporte nativo ao **Codex Desktop / ChatGPT Desktop** (`claude-codex-guard setup-codex-desktop` e `codex-guard setup-desktop`).
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
