# Changelog

## [1.4.3] - 2026-09-23

- **Melhorias na Visualização e Feed da Dashboard Web**:
  - **Correção da Ordem Cronológica do Feed**: Eliminada a inversão que empurrava as requisições mais recentes (como as do Codex hoje) para o final do scroll e deixava chamadas de dias anteriores no topo. Agora as requisições mais recentes aparecem sempre no topo do feed, tanto na carga inicial quanto em tempo real via SSE.
  - **Novo Painel de "Sessões Recentes"**: Adicionada listagem dinâmica de sessões com identificação do cliente (`Codex Desktop`, `Claude Desktop`, `Codex CLI`, `Claude Code`), projeto associado, contagem de requisições, tokens poupados e horário da última atividade.
  - **Filtros por Agente e Projeto**: Abas de filtro instantâneo no feed (`Todos`, `Codex`, `Claude`) e capacidade de clicar em uma sessão ou projeto para filtrar os eventos.
  - **Identificação Clara de Requisições Protegidas**: Chamadas que não necessitaram de cortes imediatos agora exibem explicitamente `Requisição Protegida (sem corte necessário)` e o badge com o modelo (`gpt-6-astra`, `gpt-5.6-terra`, etc.), evidenciando a interceptação e monitoramento ativo pelo proxy.
  - **Novos Endpoints de Sessão**: Adicionado `/claude-codex-guard/sessions` e incluído array de sessões em `/claude-codex-guard/stats`.

## [1.4.2] - 2026-09-23

- **Poda de Turnos Antigos na Responses API do OpenAI/Codex**:
  - Implementado agrupamento de turnos e poda inteligente de saídas antigas de ferramentas em `optimizeOpenAIResponses` (`wire_api = "responses"`).
  - Preserva os últimos `keepRecentToolTurns` turnos intactos e compacta turnos anteriores longos (> 300 caracteres) com sumário das 3 primeiras linhas e marcador neutro.
  - Agrupa chamadas e saídas paralelas de ferramentas dentro do mesmo turno sem podas prematuras.
  - Disparo de Circuit Breaker baseado em turnos consecutivos de ferramentas com aviso direcionado a instruções ou mensagens de sistema/desenvolvedor.
- **Conexões Persistentes HTTP/HTTPS (`keepAlive`)**:
  - Adicionado pool com `keepAlive: true`, `keepAliveMsecs: 10000` e `timeout: 300000` (5 minutos) para conexões upstream (`chatgpt.com`, `api.anthropic.com`, `api.openai.com`), prevenindo erros de socket fechado ou `read ETIMEDOUT` durante respostas longas de raciocínio profundo (`gpt-6-astra`, `gpt-5.6-luna`).
- **Sincronização Automática para Codex CLI**:
  - Sincronização do provedor `claude-codex-guard` diretamente em `~/.codex/config.toml` (com backup automático), garantindo que comandos `codex` executados no terminal passem automaticamente pelo proxy com proteção total sem necessidade de wrappers manuais.

## [1.4.1] - 2026-09-23

- **Resiliência do Indicador de Bandeja (System Tray) na Inicialização**:
  - Corrigido problema em que o ícone na bandeja não aparecia após o boot do sistema porque o `systemd --user` iniciava o serviço antes do GNOME Shell registrar o `StatusNotifierWatcher`.
  - Adicionada espera ativa e reconexão automática via sinais D-Bus `NameOwnerChanged` e temporizador GLib no script Python da bandeja, permitindo que ele se registre no momento em que o ambiente gráfico estiver pronto ou se o GNOME Shell for reiniciado.
  - Implementada supervisão de processo e reinício automático do indicador no Node.js (`src/notifier.js`).
  - Corrigida a geração da unidade `claude-codex-guard.service` para incluir dependência de `dbus.socket` e remover valores voláteis de GUID do `DBUS_SESSION_BUS_ADDRESS`.


## [1.4.0] - 2026-09-22

- **Correção de Falso-Positivo de Injeção de Prompt**:
  - Avisos de Circuit Breaker agora são direcionados ao prompt de sistema (`payload.system` na Anthropic, `system`/`developer` na OpenAI, e `payload.instructions` nas Responses API), prevenindo que filtros de segurança interpretem ordens no `tool_result` como Indirect Prompt Injection.
- **Marcadores de Truncamento Neutros**:
  - Cortes de saídas longas de ferramentas agora utilizam o formato padrão de CLI (`[... output truncated: N characters omitted for brevity ...]`), sem expor o nome do proxy nos dados retornados aos modelos.
- **Limites Padrão Mais Generosos**:
  - `maxToolResultChars` ampliado de `3.500` para `16.000` caracteres (~400 linhas de código sem truncamento).
  - `keepRecentToolTurns` ampliado de `2` para `4` turnos recentes preservados na íntegra.
  - `maxConsecutiveToolCalls` ampliado de `12` para `20` ações consecutivas, com suporte a desativação completa configurando `0`.
- **Tema Escuro (Dark Mode) na Dashboard**:
  - Suporte completo a Dark Mode em `src/dashboard.html` utilizando tokens OKLCH, detecção automática do tema do sistema (`prefers-color-scheme`), script inline anti-FOUC e switch manual com persistência local.
- **Encerramento Imediato do Daemon**:
  - Implementado `server.closeAllConnections()` e fallback timer no tratamento de `SIGINT`/`SIGTERM` em `src/proxy.js` e `bin/claude-codex-guard.js`, permitindo reinicializações instantâneas via `systemctl --user restart`.
- **Renomeação e Compatibilidade Multi-Provedor**:
  - Renomeado pacote e comando para `claude-codex-guard` com compatibilidade retroativa para `codex-guard`.
  - Tratamento local de preflight CORS (`OPTIONS`) com HTTP 204.
  - Roteamento aprimorado de `/v1/models` para requisições Anthropic sob OAuth.
  - Sanitização de cabeçalhos locais `Origin` e `Referer` antes do envio upstream.
  - Preservação de configurações personalizadas de plugins e ferramentas no `config.toml` do Codex Desktop.


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
