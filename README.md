# Claude-Codex-Guard

**Proxy local agnóstico de provedor para Claude e Codex, em CLI e nos fluxos desktop que aceitam endpoint configurável.**

Desenvolvido em **Node.js** puro (sem dependências externas) e testado em **Ubuntu Linux** (GNOME Shell / Wayland / X11), o projeto otimiza requisições JSON de Anthropic Messages, OpenAI Chat Completions/Responses e Codex `/backend-api/`, além de bloquear telemetria localmente.

Versão atual: **1.4.0**.

---

## Como Funciona

Agentes de codificação autônomos trabalham em um *ReAct Loop*: para cada micro-ação (leitura de arquivo, execução de bash, diff), uma requisição é enviada contendo todo o histórico acumulado.

O **Claude-Codex-Guard** atua em duas frentes complementares:

1. **Proxy Reverso Inteligente Multi-Provedor (`src/proxy.js`)**:
   - **Compatível com Anthropic & OpenAI**: Roteamento dinâmico automático para `/v1/messages` (Claude) e `/v1/chat/completions`, `/v1/responses` ou `/backend-api/` (Codex / OpenAI).
   - **Poda Histórica de Contexto (`keepRecentToolTurns: 4`)**: Preserva os resultados de ferramentas dos últimos 4 turnos intactos, mas compacta saídas de rodadas mais antigas (onde o agente já extraiu o que precisava). Reduz significativamente o inchaço cumulativo de tokens.
   - **Truncamento Cirúrgico Neutro (`maxToolResultChars: 16000`)**: Se um comando produzir milhares de linhas, o proxy preserva o início e o fim da saída com marcador neutro de CLI (`[... output truncated: N characters omitted for brevity ...]`), sem expor nomes de proxy e sem disparar filtros de segurança dos modelos.
   - **Circuit Breaker / Anti-Loop no System Prompt (`maxConsecutiveToolCalls: 20`)**: Se o agente entrar em um loop automático tentando rodar comandos repetidamente sem intervenção humana, o proxy injeta uma instrução segura no System Prompt (`payload.system` ou mensagem `developer`), forçando o agente a pausar e pedir confirmação ao usuário sem falsos-positivos de injeção de prompt. Suporta valor `0` para desativar.
   - **Zero Latência & Tunneling CONNECT**: Streaming transparente e suporte a túneis HTTPS.
   - **Reconexão Transparente**: Reconecta-se automaticamente a instâncias ativas do proxy sem conflito de portas.

2. **Shims de Shell Pré-Execução (`shims/`)**:
   - `shims/cat`: Detecta leitura de arquivos com mais de 200 linhas e exibe fatias com alerta em vez de cuspir o arquivo inteiro para o contexto.
   - `shims/git`: Força paginação em `git log` (`-n 20`) e trunca diffs gigantes (`git diff`).
   - `shims/find`: Força profundidade máxima segura e limita resultados a 80 itens.
   - `shims/npm`: Suprime barras de progresso barulhentas em `npm test`/`run` e resume saídas extensas.

---

## Instalação e Configuração

> [!NOTE]
> **Compatibilidade e Ambiente**:
> - Desenvolvido e validado em **Ubuntu Linux** (22.04 LTS e 24.04 LTS, GNOME Shell com Wayland e X11, systemd `--user`).
> - Requer **Node.js >= 22** (utiliza o módulo nativo `node:sqlite` para persistência local rápida, sem compilações externas).
> - Sem dependências externas (`node_modules` de terceiros não são necessários).

### Passo 1: Baixar / Clonar o Repositório

Clone o repositório em uma pasta local no seu ambiente:

```bash
git clone https://github.com/mensonones/claude-codex-guard.git
cd claude-codex-guard
```

### Passo 2: Instalação Global Automática

A partir da raiz do repositório clonado, execute o instalador:

```bash
node bin/claude-codex-guard.js install
```

O que o instalador faz automaticamente:
1. Registra os comandos globais `claude-codex-guard` e `codex-guard` no seu ambiente.
2. Identifica os clientes instalados no sistema — **Claude CLI / Code**, **Codex CLI**, **Claude Desktop** e **ChatGPT / Codex Desktop**.
3. Reconfigura os wrappers desktop em `~/.local/bin/` (`claude-desktop` e `chatgpt`), criando backups dos arquivos anteriores (`*.backup`). Se preferir instalar apenas para CLI sem alterar aplicativos gráficos, utilize a flag `--no-desktop`:
   ```bash
   node bin/claude-codex-guard.js install --no-desktop
   ```
4. Salva o caminho de origem em `~/.config/claude-codex-guard/installation.json` para permitir atualizações automáticas futuras.

### Passo 3: Inicialização Automática no Sistema (Recomendado)

No Ubuntu e distros baseadas em systemd, ative a inicialização do proxy junto ao login do usuário:

```bash
claude-codex-guard autostart enable
```

Para checar o status do serviço:
```bash
claude-codex-guard autostart status
```

Se desejar desativar:
```bash
claude-codex-guard autostart disable
```

### Atualizações Futuras

Para atualizar a instalação global após puxar novas atualizações com `git pull`:

```bash
# Na pasta do repositório:
git pull

# Atualizar a instalação global:
claude-codex-guard update
```

*(Além disso, ao executar `claude-codex-guard`, o comando verifica automaticamente se a pasta de origem possui versão mais recente e atualiza a instalação global).*

---

## Como Usar

### 1. Com o Claude Code CLI
```bash
# Executar diretamente com proxy e shims protetores:
claude-codex-guard

# Ou passando comandos/prompts normalmente:
claude-codex-guard "analise o diff atual"
```

### 2. Com o OpenAI Codex CLI
Você pode usar tanto o comando dedicado `codex-guard` quanto `claude-codex-guard codex`:
```bash
# Executar com proteção e shims:
codex-guard

# Ou passar quaisquer opções e comandos do Codex:
codex-guard exec "revisar o diff atual"
codex-guard -m gpt-5.6-luna

# Ou via comando principal:
claude-codex-guard codex
```

O wrapper do Codex injeta um provider local HTTP-only (`wire_api = "responses"`, `supports_websockets = false`) apontando para o proxy. Isso é necessário porque o Codex pode ignorar `OPENAI_BASE_URL` quando há um `model_providers.<nome>.base_url` configurado e usa WebSocket por padrão. As chamadas JSON HTTP chegam ao otimizador, ao SQLite e ao feed SSE da dashboard. O wrapper não usa `HTTPS_PROXY` nesse fluxo, pois isso criaria um túnel CONNECT criptografado impossível de inspecionar.

Mesmo quando o Codex reutiliza um proxy já aberto pelo Claude Desktop, as requisições Codex são separadas por cliente e aparecem no resumo de agentes da dashboard.

O launcher registra a sessão na abertura. A captura de tokens só é possível quando o cliente desktop usa o endpoint/base URL ou proxy configurável. O aplicativo ChatGPT desktop oficial pode ignorar essas variáveis e usar uma conexão própria; nesse caso ele não oferece um ponto suportado para interceptação e deve ser validado pelo status/dashboard, sem assumir que foi capturado.

### 3. Com Aplicativos Desktop (Claude Desktop & ChatGPT / Codex Desktop)

Caso precise reconfigurar os atalhos desktop individualmente a qualquer momento:

```bash
# Para Claude Desktop:
claude-codex-guard setup-desktop

# Para ChatGPT / Codex Desktop:
claude-codex-guard setup-codex-desktop
# (ou pelo alias: codex-guard setup-desktop)
```

O launcher exporta `OPENAI_BASE_URL` e `CODEX_API_BASE` e cria um `CODEX_HOME` isolado com provider HTTP-only, preservando o `auth.json` existente. Isso evita alterar o `~/.codex/config.toml` do usuário. Depois de alterar essa configuração, reinicie o proxy e o aplicativo para renovar o ambiente do processo.

A partir de agora:
1. Sempre que você abrir o Claude Desktop ou o ChatGPT Desktop pelo menu do sistema ou terminal, o proxy sobe silenciosamente em background.
2. Clientes que aceitam endpoint configurável passam pelo filtro anti-desperdício; os shims são aplicados apenas ao processo lançado pelo wrapper.
3. Você pode consultar em tempo real a economia de tokens com:
   ```bash
   claude-codex-guard status
   ```

### 4. Dashboard Web em Tempo Real
Monitore visualmente o trabalho do Claude-Codex-Guard diretamente pelo navegador enquanto utiliza o Claude Desktop, Claude Code ou Codex:

```bash
# Abre o painel em tempo real no seu navegador padrão:
claude-codex-guard dashboard
# (ou pelo alias: claude-codex-guard ui)
```

Ou acesse diretamente: **`http://localhost:48080/dashboard`**

O painel foi desenhado como um cockpit moderno e compacto, com suporte completo a **Tema Claro e Tema Escuro (Dark Mode)**, alternância por switch na barra superior e detecção automática da preferência do sistema operacional (`prefers-color-scheme`).

**Recursos do Dashboard:**
- **Live Activity Feed (SSE)**: exibe cada requisição interceptada em tempo real, com projeto, origem, método e tokens poupados.
- **Resumo de eficiência**: economia estimada, percentual médio de corte, tokens poupados e chamadas interceptadas.
- **Anti-loop e telemetria**: sinaliza loops bloqueados, resultados truncados, turnos podados e telemetrias neutralizadas.
- **Divisão por projeto**: mostra os repositórios ativos e a contribuição de cada um para a economia.
- **Auditoria detalhada**: abre o histórico recente e a telemetria bloqueada em um painel lateral, sem perder o contexto da dashboard.
- **Horários localizados**: eventos são apresentados em `America/Sao_Paulo`, adequado ao uso no Brasil.

O dashboard usa os dados disponíveis no SQLite e na sessão atual. Quando não há eventos, os cartões exibem estados vazios em vez de inventar métricas.

### 5. Relatórios de Economia & Histórico (SQLite)
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

### 6. Indicador na Bandeja do Sistema (System Tray no Ubuntu / Linux)
O Claude-Codex-Guard integra-se nativamente com ambientes Linux (GNOME Shell / Wayland, Ubuntu AppIndicators, KDE):
- **Notificação OSD (`notify-send`)**: emitida automaticamente ao iniciar o proxy e ao acionar o Circuit Breaker.
- **Indicador na Bandeja (System Tray)**: exibe o escudo protetor no painel superior com menu de atalho:
  ```bash
  claude-codex-guard tray
  ```
  O menu da bandeja permite abrir o Dashboard com 1 clique, inspecionar a economia de tokens acumulada e encerrar o serviço graciosamente.

### 7. Modo Proxy Manual / Standalone
Se preferir rodar o proxy em primeiro plano manualmente:

```bash
# 1. Inicia o proxy (emite notificação no desktop e sobe ícone na bandeja)
claude-codex-guard proxy

# 2. Em outro terminal, aponte a variável para o proxy:
export ANTHROPIC_BASE_URL="http://127.0.0.1:48080"
claude
```


---

## Variáveis de Ambiente & Customizações

Você pode ajustar os limites criando um arquivo `claude-codex-guard.config.json` ou definindo variáveis de ambiente:

| Variável | Padrão | Descrição |
| :--- | :--- | :--- |
| `CLAUDE_CODEX_GUARD_PORT` | `48080` | Porta local do proxy |
| `CLAUDE_CODEX_GUARD_MAX_TOOL_CHARS` | `16000` | Limite de caracteres por saída de ferramenta (~4.000 tokens) |
| `CLAUDE_CODEX_GUARD_KEEP_TURNS` | `4` | Quantidade de turnos recentes de ferramentas preservados |
| `CLAUDE_CODEX_GUARD_MAX_LOOPS` | `20` | Limite do Circuit Breaker para chamadas de ferramentas seguidas (`0` desativa) |
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
