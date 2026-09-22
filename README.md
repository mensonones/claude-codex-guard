# Claude-Codex-Guard

**Proxy local agnóstico de provedor para Claude e Codex, em CLI e nos fluxos desktop que aceitam endpoint configurável.**

Desenvolvido em **Node.js** puro (sem dependências externas), o projeto otimiza requisições JSON de Anthropic Messages, OpenAI Chat Completions/Responses e Codex `/backend-api/`, além de bloquear telemetria localmente.

Versão atual: **1.3.4**.

---

## Como Funciona

Agentes de codificação autônomos trabalham em um *ReAct Loop*: para cada micro-ação (leitura de arquivo, execução de bash, diff), uma requisição é enviada contendo todo o histórico acumulado.

O **Claude-Codex-Guard** atua em duas frentes complementares:

1. **Proxy Reverso Inteligente Multi-Provedor (`src/proxy.js`)**:
   - **Compatível com Anthropic & OpenAI**: Roteamento dinâmico automático para `/v1/messages` (Claude) e `/v1/chat/completions`, `/v1/responses` ou `/backend-api/` (Codex / OpenAI).
   - **Poda Histórica de Contexto (`keepRecentToolTurns: 2`)**: Preserva os resultados de ferramentas recentes intactos, mas compacta saídas de rodadas anteriores (onde o agente já extraiu o que precisava). Reduz em até 70% o inchaço cumulativo de tokens.
   - **Truncamento Cirúrgico (`maxToolResultChars: 3500`)**: Se um comando produzir milhares de linhas, o proxy preserva o início e o fim do log com marcador explícito de corte, evitando faturar arquivos gigantes desnecessariamente.
   - **Circuit Breaker / Anti-Loop (`maxConsecutiveToolCalls: 12`)**: Se o agente entrar em um loop automático tentando rodar comandos repetidamente sem intervenção humana, o proxy injeta uma instrução forçando o agente a parar, reportar os achados e pedir confirmação ao usuário.
   - **Zero Latência & Tunneling CONNECT**: Streaming transparente e suporte a túneis HTTPS.
   - **Reconexão Transparente**: Reconecta-se automaticamente a instâncias ativas do proxy sem conflito de portas.

2. **Shims de Shell Pré-Execução (`shims/`)**:
   - `shims/cat`: Detecta leitura de arquivos com mais de 200 linhas e exibe fatias com alerta em vez de cuspir o arquivo inteiro para o contexto.
   - `shims/git`: Força paginação em `git log` (`-n 20`) e trunca diffs gigantes (`git diff`).
   - `shims/find`: Força profundidade máxima segura e limita resultados a 80 itens.
   - `shims/npm`: Suprime barras de progresso barulhentas em `npm test`/`run` e resume saídas extensas.

---

## Como Usar

### Instalação global e atualização automática

A instalação identifica os clientes disponíveis no ambiente — Claude CLI/Code, Codex CLI, Claude Desktop e ChatGPT/Codex Desktop — e registra a origem da instalação:

```bash
claude-codex-guard install
```

Para atualizar manualmente a instalação global:

```bash
claude-codex-guard update
```

Quando uma nova versão for encontrada no caminho de origem registrado, o comando global atualiza a instalação automaticamente antes de executar a ação solicitada. Use `--no-desktop` para instalar sem reconfigurar launchers gráficos.

### 1. Com o Claude Code CLI
```bash
# Executar a partir da pasta do projeto:
./bin/claude-codex-guard.js

# Ou após 'npm link' global:
claude-codex-guard
```

### 2. Com o OpenAI Codex CLI
Você pode usar tanto o comando dedicado `codex-guard` quanto `claude-codex-guard codex`:
```bash
# Executar com proteção e shims:
./bin/codex-guard.js

# Ou passar quaisquer opções do Codex:
./bin/codex-guard.js exec "revisar o diff atual"
./bin/codex-guard.js -m gpt-5.6-luna

# Ou via alias:
claude-codex-guard codex
```

O wrapper do Codex injeta um provider local HTTP-only (`wire_api = "responses"`, `supports_websockets = false`) apontando para o proxy. Isso é necessário porque o Codex pode ignorar `OPENAI_BASE_URL` quando há um `model_providers.<nome>.base_url` configurado e usa WebSocket por padrão. As chamadas JSON HTTP chegam ao otimizador, ao SQLite e ao feed SSE da dashboard. O wrapper não usa `HTTPS_PROXY` nesse fluxo, pois isso criaria um túnel CONNECT criptografado impossível de inspecionar.

Mesmo quando o Codex reutiliza um proxy já aberto pelo Claude Desktop, as requisições Codex são separadas por cliente e aparecem no resumo de agentes da dashboard.

O launcher registra a sessão na abertura. A captura de tokens só é possível quando o cliente desktop usa o endpoint/base URL ou proxy configurável. O aplicativo ChatGPT desktop oficial pode ignorar essas variáveis e usar uma conexão própria; nesse caso ele não oferece um ponto suportado para interceptação e deve ser validado pelo status/dashboard, sem assumir que foi capturado.

### 3. Integração Automática com Aplicativos Desktop

#### Para Claude Desktop:
```bash
claude-codex-guard setup-desktop
```

#### Para ChatGPT / Codex Desktop:
```bash
claude-codex-guard setup-codex-desktop
# (ou pelo alias: codex-guard setup-desktop)
```

O launcher exporta `OPENAI_BASE_URL` e `CODEX_API_BASE` e cria um `CODEX_HOME` isolado com provider HTTP-only, preservando o `auth.json` existente. Isso evita alterar o `~/.codex/config.toml` do usuário. Depois de alterar essa configuração, reinicie o proxy e o aplicativo para renovar o ambiente do processo.

A partir de agora:
1. Sempre que você abrir o Claude Desktop ou o ChatGPT Desktop, o proxy otimizador sobe silenciosamente em background.
2. Clientes que aceitam endpoint configurável passam pelo filtro anti-desperdício; os shims são aplicados apenas ao processo lançado pelo wrapper.
3. Você pode consultar em tempo real a economia de tokens com:
   ```bash
   claude-codex-guard status
   ```

### Dashboard Web em Tempo Real
Monitore visualmente o trabalho do Claude-Codex-Guard diretamente pelo navegador enquanto utiliza o Claude Desktop ou Claude Code:

```bash
# Abre o painel em tempo real no seu navegador padrão:
claude-codex-guard dashboard
# (ou pelo alias: claude-codex-guard ui)
```

Ou acesse diretamente: **`http://localhost:48080/dashboard`**

O painel foi redesenhado como um cockpit claro e compacto, com navegação lateral, resumo de saúde, cartões de economia e áreas de auditoria. Ele mantém a densidade visual de uma ferramenta operacional sem depender de tema escuro.

**Recursos do Dashboard:**
- **Live Activity Feed (SSE)**: exibe cada requisição interceptada em tempo real, com projeto, origem, método e tokens poupados.
- **Resumo de eficiência**: economia estimada, percentual médio de corte, tokens poupados e chamadas interceptadas.
- **Anti-loop e telemetria**: sinaliza loops bloqueados, resultados truncados, turnos podados e telemetrias neutralizadas.
- **Divisão por projeto**: mostra os repositórios ativos e a contribuição de cada um para a economia.
- **Auditoria detalhada**: abre o histórico recente e a telemetria bloqueada em um painel lateral, sem perder o contexto da dashboard.
- **Horários localizados**: eventos são apresentados em `America/Sao_Paulo`, adequado ao uso no Brasil.

O dashboard usa os dados disponíveis no SQLite e na sessão atual. Quando não há eventos, os cartões exibem estados vazios em vez de inventar métricas.

### Relatórios de Economia & Histórico (SQLite)
O Claude-Codex-Guard grava todas as métricas em um banco SQLite nativo (`~/.config/claude-codex-guard/history.db`). Você pode consultar seus relatórios no terminal a qualquer momento:

```bash
# Relatório completo consolidado + últimos dias
claude-codex-guard report

# Filtrar o relatório para um projeto específico (ex: justofood, argus)
claude-codex-guard report --project justofood

# Apenas o consumo e economia de hoje
claude-codex-guard report --today

# Exportar dados para CSV ou JSON (ótimo para planilhas)
claude-codex-guard report --export csv > economia.csv
claude-codex-guard report --project argus --export csv > argus_economia.csv

# Limpar histórico do banco
claude-codex-guard report --clear
```

### Opção 3: Modo Proxy Standalone
Se preferir rodar o proxy em segundo plano manualmente:

```bash
# 1. Inicia o proxy (emite notificação no desktop e sobe ícone na bandeja)
claude-codex-guard proxy

# 2. Em outro terminal, aponte a variável para o proxy:
export ANTHROPIC_BASE_URL="http://127.0.0.1:48080"
claude
```

### 4. Notificações & Bandeja do Sistema (Linux)
O Claude-Codex-Guard integra-se nativamente com ambientes Linux (GNOME Shell / Wayland, Ubuntu AppIndicators, KDE):
- **Notificação OSD (`notify-send`)**: emitida automaticamente ao iniciar o proxy e ao acionar o Circuit Breaker.
- **Indicador na Bandeja (System Tray)**: exibe o escudo protetor no painel superior com menu de atalho:
  ```bash
  # Iniciar o indicador de bandeja individualmente:
  claude-codex-guard tray
  ```
  O menu da bandeja permite abrir o Dashboard com 1 clique, inspecionar a economia de tokens acumulada e encerrar o serviço graciosamente.

### 5. Inicialização Automática com o Sistema (Autostart)
Configure o Claude-Codex-Guard para iniciar automaticamente com o seu sistema operacional via `systemd --user` e XDG Autostart:

```bash
# Ativar início automático com o sistema:
claude-codex-guard autostart enable

# Verificar status da inicialização automática:
claude-codex-guard autostart status

# Desativar e remover serviços de inicialização:
claude-codex-guard autostart disable
```
*(Também disponível através de `codex-guard autostart [enable|disable|status]`)*


---

## Variáveis de Ambiente & Customizações

Você pode ajustar os limites criando um arquivo `claude-codex-guard.config.json` ou definindo variáveis de ambiente:

| Variável | Padrão | Descrição |
| :--- | :--- | :--- |
| `CLAUDE_CODEX_GUARD_PORT` | `48080` | Porta local do proxy |
| `CLAUDE_CODEX_GUARD_MAX_TOOL_CHARS` | `3500` | Limite de caracteres por saída de ferramenta (~900 tokens) |
| `CLAUDE_CODEX_GUARD_KEEP_TURNS` | `2` | Quantidade de turnos recentes de ferramentas preservados |
| `CLAUDE_CODEX_GUARD_MAX_LOOPS` | `12` | Limite do Circuit Breaker para chamadas de ferramentas seguidas |
| `CLAUDE_CODEX_GUARD_ENABLE_SHIMS` | `true` | Habilitar/desabilitar shims de terminal (`cat`, `git`, `find`, `npm`) |

---

## Testes

Para executar a suíte de testes unitários e de integração:
```bash
npm test
```

Os testes unitários cobrem o banco, o otimizador e a detecção de projetos. Os testes do servidor proxy precisam de permissão para abrir um listener HTTP local no ambiente de execução.

## Operação local

O proxy e o dashboard foram projetados para uso local. O histórico fica em `~/.config/claude-codex-guard/history.db` e não deve ser exposto publicamente sem uma camada de autenticação e controle de origem. O dashboard não usa favicon baseado em emoji e os dados dinâmicos são escapados antes de serem renderizados.

## Licença

MIT.
