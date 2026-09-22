# Claude-Guard

**Otimizador Ativo de Tokens e Interceptador de Loops para o Claude Code.**

Desenvolvido em **Node.js** puro (sem dependências externas), o **Claude-Guard** atua ativamente para reduzir drasticamente o consumo de tokens e cortar requisições repetitivas ou descontroladas do Claude Code.

Versão atual: **1.1.0**.

---

## Como Funciona

O Claude Code trabalha em um *ReAct Loop*: para cada micro-ação (leitura de arquivo, execução de bash, grep), uma requisição é enviada para a Anthropic contendo todo o histórico acumulado.

O **Claude-Guard** atua em duas frentes complementares:

1. **Proxy Reverso Inteligente (`src/proxy.js`)**:
   - **Poda Histórica de Contexto (`keepRecentToolTurns: 2`)**: Preserva os resultados de ferramentas recentes intactos, mas compacta saídas de rodadas anteriores (onde o Claude já extraiu o que precisava). Reduz em até 70% o inchaço cumulativo de tokens.
   - **Truncamento Cirúrgico (`maxToolResultChars: 3500`)**: Se um comando produzir milhares de linhas, o proxy preserva o início e o fim do log com marcador explícito de corte, evitando faturar arquivos gigantes desnecessariamente.
   - **Circuit Breaker / Anti-Loop (`maxConsecutiveToolCalls: 12`)**: Se o agente entrar em um loop automático tentando rodar comandos repetidamente sem intervenção humana, o proxy injeta uma instrução forçando o agente a parar, reportar os achados e pedir confirmação ao usuário.
   - **Zero Latência**: Streaming SSE transparente direto da Anthropic.

2. **Shims de Shell Pré-Execução (`shims/`)**:
   - `shims/cat`: Detecta leitura de arquivos com mais de 200 linhas e exibe fatias com alerta em vez de cuspir o arquivo inteiro para o contexto.
   - `shims/git`: Força paginação em `git log` (`-n 20`) e trunca diffs gigantes (`git diff`).
   - `shims/find`: Força profundidade máxima segura e limita resultados a 80 itens.
   - `shims/npm`: Suprime barras de progresso barulhentas em `npm test`/`run` e resume saídas extensas.

---

## Como Usar

### Opção 1: Via Wrapper Direto (Recomendado)
Basta substituir a chamada do comando `claude` por `claude-guard`:

```bash
# Executar a partir da pasta do projeto:
./bin/claude-guard.js

# Ou com qualquer argumento do Claude:
./bin/claude-guard.js --model claude-3-7-sonnet-20250219
```

Para tornar o comando global no seu sistema:
```bash
cd /home/emerson-vieira/dev/opensource/claude-guard
npm link
# Agora você pode rodar de qualquer diretório:
claude-guard
```

### Opção 2: Integração Automática com o Claude Desktop
Se você usa o **Claude Desktop** (inclusive com sessões integradas de Claude Code):
O instalador já integrou automaticamente o Claude-Guard ao inicializador do app:

```bash
claude-guard setup-desktop
```

A partir de agora:
1. Sempre que você abrir o Claude Desktop, o proxy otimizador sobe silenciosamente em background.
2. Todas as ações de código executadas pelo app usam os shims (`cat`, `git`, `find`, `npm`) e passam pelo filtro anti-desperdício de tokens.
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

Ou acesse diretamente: **`http://localhost:8080/dashboard`**

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
# 1. Inicia o proxy
claude-guard proxy

# 2. Em outro terminal, aponte a variável para o proxy:
export ANTHROPIC_BASE_URL="http://127.0.0.1:8080"
claude
```

---

## Variáveis de Ambiente & Customizações

Você pode ajustar os limites criando um arquivo `claude-guard.config.json` ou definindo variáveis de ambiente:

| Variável | Padrão | Descrição |
| :--- | :--- | :--- |
| `CLAUDE_GUARD_PORT` | `8080` | Porta local do proxy |
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
