# Claude-Guard & Codex-Guard

**Otimizador Ativo de Tokens e Interceptador de Loops para Claude Code e OpenAI Codex.**

Desenvolvido em **Node.js** puro (sem dependências externas), o **Claude-Guard** atua ativamente para reduzir drasticamente o consumo de tokens e cortar requisições repetitivas ou loops agênticos descontrolados tanto no **Claude Code / Desktop** quanto no **OpenAI Codex CLI / Desktop**.

Versão atual: **1.3.3**.

---

## Como Funciona

Agentes de codificação autônomos trabalham em um *ReAct Loop*: para cada micro-ação (leitura de arquivo, execução de bash, diff), uma requisição é enviada contendo todo o histórico acumulado.

O **Claude-Guard** atua em duas frentes complementares:

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
claude-guard install
```

Para atualizar manualmente a instalação global:

```bash
claude-guard update
```

Quando uma nova versão for encontrada no caminho de origem registrado, o comando global atualiza a instalação automaticamente antes de executar a ação solicitada. Use `--no-desktop` para instalar sem reconfigurar launchers gráficos.

### 1. Com o Claude Code CLI
```bash
# Executar a partir da pasta do projeto:
./bin/claude-guard.js

# Ou após 'npm link' global:
claude-guard
```

### 2. Com o OpenAI Codex CLI
Você pode usar tanto o comando dedicado `codex-guard` quanto `claude-guard codex`:
```bash
# Executar com proteção e shims:
./bin/codex-guard.js

# Ou passar quaisquer opções do Codex:
./bin/codex-guard.js exec "revisar o diff atual"
./bin/codex-guard.js -m gpt-5.6-luna

# Ou via alias:
claude-guard codex
```

O wrapper do Codex aponta `OPENAI_BASE_URL` para o proxy local. Assim, as chamadas JSON chegam ao otimizador, ao SQLite e ao feed SSE da dashboard. O wrapper não usa `HTTPS_PROXY` nesse fluxo, pois isso criaria um túnel CONNECT criptografado impossível de inspecionar.

Mesmo quando o Codex reutiliza um proxy já aberto pelo Claude Desktop, as requisições Codex são separadas por cliente e aparecem no resumo de agentes da dashboard.

O launcher do ChatGPT/Codex Desktop também registra a sessão na abertura, então o agente aparece na dashboard antes do primeiro prompt.

### 3. Integração Automática com Aplicativos Desktop

#### Para Claude Desktop:
```bash
claude-guard setup-desktop
```

#### Para ChatGPT / Codex Desktop:
```bash
claude-guard setup-codex-desktop
# (ou pelo alias: codex-guard setup-desktop)
```

O launcher também exporta `OPENAI_BASE_URL` e `CODEX_API_BASE` para a porta local. Depois de alterar essa configuração, reinicie o proxy e o aplicativo desktop para renovar o ambiente do processo.

A partir de agora:
1. Sempre que você abrir o Claude Desktop ou o ChatGPT Desktop, o proxy otimizador sobe silenciosamente em background.
2. Todas as ações de código executadas pelos apps usam os shims (`cat`, `git`, `find`, `npm`) e passam pelo filtro anti-desperdício de tokens.
3. Você pode consultar em tempo real a economia de tokens com:
   ```bash
   claude-guard status
   ```

### Dashboard Web em Tempo Real
Monitore visualmente o trabalho do Claude-Guard diretamente pelo navegador enquanto utiliza o Claude Desktop ou Claude Code:

```bash
# Abre o painel em tempo real no seu navegador padrão:
claude-guard dashboard
# (ou pelo alias: claude-guard ui)
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
O Claude-Guard grava todas as métricas em um banco SQLite nativo (`~/.config/claude-guard/history.db`). Você pode consultar seus relatórios no terminal a qualquer momento:

```bash
# Relatório completo consolidado + últimos dias
claude-guard report

# Filtrar o relatório para um projeto específico (ex: justofood, argus)
claude-guard report --project justofood

# Apenas o consumo e economia de hoje
claude-guard report --today

# Exportar dados para CSV ou JSON (ótimo para planilhas)
claude-guard report --export csv > economia.csv
claude-guard report --project argus --export csv > argus_economia.csv

# Limpar histórico do banco
claude-guard report --clear
```

### Opção 3: Modo Proxy Standalone
Se preferir rodar o proxy em segundo plano manualmente:

```bash
# 1. Inicia o proxy (emite notificação no desktop e sobe ícone na bandeja)
claude-guard proxy

# 2. Em outro terminal, aponte a variável para o proxy:
export ANTHROPIC_BASE_URL="http://127.0.0.1:48080"
claude
```

### 4. Notificações & Bandeja do Sistema (Linux)
O Claude-Guard integra-se nativamente com ambientes Linux (GNOME Shell / Wayland, Ubuntu AppIndicators, KDE):
- **Notificação OSD (`notify-send`)**: emitida automaticamente ao iniciar o proxy e ao acionar o Circuit Breaker.
- **Indicador na Bandeja (System Tray)**: exibe o escudo protetor no painel superior com menu de atalho:
  ```bash
  # Iniciar o indicador de bandeja individualmente:
  claude-guard tray
  ```
  O menu da bandeja permite abrir o Dashboard com 1 clique, inspecionar a economia de tokens acumulada e encerrar o serviço graciosamente.

### 5. Inicialização Automática com o Sistema (Autostart)
Configure o Claude-Guard para iniciar automaticamente com o seu sistema operacional via `systemd --user` e XDG Autostart:

```bash
# Ativar início automático com o sistema:
claude-guard autostart enable

# Verificar status da inicialização automática:
claude-guard autostart status

# Desativar e remover serviços de inicialização:
claude-guard autostart disable
```
*(Também disponível através de `codex-guard autostart [enable|disable|status]`)*


---

## Variáveis de Ambiente & Customizações

Você pode ajustar os limites criando um arquivo `claude-guard.config.json` ou definindo variáveis de ambiente:

| Variável | Padrão | Descrição |
| :--- | :--- | :--- |
| `CLAUDE_GUARD_PORT` | `48080` | Porta local do proxy |
| `CLAUDE_GUARD_MAX_TOOL_CHARS` | `3500` | Limite de caracteres por saída de ferramenta (~900 tokens) |
| `CLAUDE_GUARD_KEEP_TURNS` | `2` | Quantidade de turnos recentes de ferramentas preservados |
| `CLAUDE_GUARD_MAX_LOOPS` | `12` | Limite do Circuit Breaker para chamadas de ferramentas seguidas |
| `CLAUDE_GUARD_ENABLE_SHIMS` | `true` | Habilitar/desabilitar shims de terminal (`cat`, `git`, `find`, `npm`) |

---

## Testes

Para executar a suíte de testes unitários e de integração:
```bash
npm test
```

Os testes unitários cobrem o banco, o otimizador e a detecção de projetos. Os testes do servidor proxy precisam de permissão para abrir um listener HTTP local no ambiente de execução.

## Operação local

O proxy e o dashboard foram projetados para uso local. O histórico fica em `~/.config/claude-guard/history.db` e não deve ser exposto publicamente sem uma camada de autenticação e controle de origem. O dashboard não usa favicon baseado em emoji e os dados dinâmicos são escapados antes de serem renderizados.

## Licença

MIT.
