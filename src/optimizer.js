/**
 * Optimizer logic for Anthropic Messages API payloads
 */

export class TokenOptimizer {
  constructor(config) {
    this.config = config;
    this.stats = {
      totalRequests: 0,
      totalOriginalChars: 0,
      totalOptimizedChars: 0,
      charsSaved: 0,
      estimatedTokensSaved: 0,
      circuitBreakerTriggered: 0,
      truncatedToolResults: 0,
      prunedToolResults: 0,
      telemetryBlocked: 0
    };
  }

  /**
   * Estimates token count from string length
   */
  estimateTokens(text) {
    if (!text || typeof text !== 'string') return 0;
    // Common heuristic for code + natural text in LLMs is ~3.8 chars per token
    return Math.round(text.length / 3.8);
  }

  /**
   * Helper to truncate long text preserving head and tail
   */
  truncateText(text, maxChars) {
    if (typeof text !== 'string' || text.length <= maxChars) {
      return { text, truncated: false, savedChars: 0 };
    }

    const half = Math.floor((maxChars - 120) / 2);
    const head = text.slice(0, Math.max(0, half));
    const tail = text.slice(-Math.max(0, half));
    const prunedCount = text.length - (head.length + tail.length);

    const replacement = `${head}\n\n[... claude-guard: ${prunedCount} caracteres truncados para poupar tokens ...]\n\n${tail}`;
    return {
      text: replacement,
      truncated: true,
      savedChars: text.length - replacement.length
    };
  }

  /**
   * Detects if the payload follows OpenAI Chat Completions / Responses format
   */
  detectIsOpenAI(payload) {
    if (!payload || !Array.isArray(payload.messages)) return false;
    for (const msg of payload.messages) {
      if (
        msg.role === 'tool' ||
        msg.role === 'function' ||
        (msg.role === 'assistant' && Array.isArray(msg.tool_calls))
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Optimize OpenAI format payloads (role: 'tool' or role: 'function')
   */
  optimizeOpenAI(payload) {
    const messages = payload.messages;
    const toolGroups = [];
    let activeGroup = null;
    let consecutiveToolTurns = 0;

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
        activeGroup = { resultIndices: [] };
        toolGroups.push(activeGroup);
        consecutiveToolTurns++;
      } else if (msg.role === 'tool' || msg.role === 'function') {
        if (!activeGroup) {
          activeGroup = { resultIndices: [] };
          toolGroups.push(activeGroup);
          consecutiveToolTurns++;
        }
        activeGroup.resultIndices.push(i);
      } else if (msg.role === 'user') {
        consecutiveToolTurns = 0;
        activeGroup = null;
      }
    }

    const toolIndices = toolGroups.flatMap(group => group.resultIndices);

    let circuitBreakerActivated = false;
    if (consecutiveToolTurns >= this.config.maxConsecutiveToolCalls) {
      circuitBreakerActivated = true;
      this.stats.circuitBreakerTriggered++;
    }

    const recentIndicesSet = new Set(
      toolGroups.slice(-Math.max(1, this.config.keepRecentToolTurns))
        .flatMap(group => group.resultIndices)
    );

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role !== 'tool' && msg.role !== 'function') continue;

      const isOlderTurn = !recentIndicesSet.has(i);

      if (typeof msg.content === 'string') {
        if (isOlderTurn && msg.content.length > 300) {
          const lines = msg.content.split('\n');
          const summary = lines.slice(0, 3).join('\n');
          const originalLength = msg.content.length;
          msg.content = `${summary}\n[... claude-guard: ${originalLength} caracteres de saída anterior compactados ...]`;
          this.stats.prunedToolResults++;
        } else {
          const res = this.truncateText(msg.content, this.config.maxToolResultChars);
          if (res.truncated) {
            msg.content = res.text;
            this.stats.truncatedToolResults++;
          }
        }
      } else if (Array.isArray(msg.content)) {
        for (let sub of msg.content) {
          if (sub && typeof sub.text === 'string') {
            if (isOlderTurn && sub.text.length > 300) {
              const lines = sub.text.split('\n');
              const summary = lines.slice(0, 3).join('\n');
              const originalLength = sub.text.length;
              sub.text = `${summary}\n[... claude-guard: ${originalLength} caracteres de saída anterior compactados ...]`;
              this.stats.prunedToolResults++;
            } else {
              const res = this.truncateText(sub.text, this.config.maxToolResultChars);
              if (res.truncated) {
                sub.text = res.text;
                this.stats.truncatedToolResults++;
              }
            }
          }
        }
      }

      // If circuit breaker triggered and this is the latest tool result, inject warning
      if (circuitBreakerActivated && i === toolIndices[toolIndices.length - 1]) {
        const warning = `\n\n[AVISO CRÍTICO - CODEX-GUARD CIRCUIT BREAKER]: Você já executou ${consecutiveToolTurns} ações de ferramentas consecutivas sem intervenção humana. PARE agora, resuma objetivamente o que já fez até aqui e peça confirmação ao usuário antes de continuar.`;
        if (typeof msg.content === 'string') {
          msg.content += warning;
        } else if (Array.isArray(msg.content) && msg.content.length > 0) {
          if (typeof msg.content[msg.content.length - 1].text === 'string') {
            msg.content[msg.content.length - 1].text += warning;
          }
        }
      }
    }

    return circuitBreakerActivated;
  }

  optimizeOpenAIResponses(payload) {
    const items = Array.isArray(payload.input) ? payload.input : [];
    const toolOutputs = [];
    let functionCalls = 0;

    const visit = value => {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      if (value.type === 'function_call') functionCalls++;
      if (value.type === 'function_call_output' && typeof value.output === 'string') {
        toolOutputs.push(value);
      }
      Object.values(value).forEach(visit);
    };
    visit(items);

    const circuitBreakerActivated = functionCalls >= this.config.maxConsecutiveToolCalls;
    if (circuitBreakerActivated) this.stats.circuitBreakerTriggered++;

    for (const outputItem of toolOutputs) {
      const result = this.truncateText(outputItem.output, this.config.maxToolResultChars);
      if (result.truncated) {
        outputItem.output = result.text;
        this.stats.truncatedToolResults++;
      }
    }

    if (circuitBreakerActivated && toolOutputs.length > 0) {
      toolOutputs[toolOutputs.length - 1].output += `\n\n[AVISO CRÍTICO - CODEX-GUARD CIRCUIT BREAKER]: Você já executou ${functionCalls} ações de ferramentas consecutivas sem intervenção humana. PARE agora, resuma objetivamente o que já fez até aqui e peça confirmação ao usuário antes de continuar.`;
    }

    return circuitBreakerActivated;
  }

  /**
   * Optimize Anthropic format payloads (content blocks with type: 'tool_result')
   */
  optimizeAnthropic(payload) {
    const messages = payload.messages;

    // 1. Identify tool result turn indices
    const toolResultIndices = [];
    let consecutiveToolTurns = 0;

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role === 'user' && Array.isArray(msg.content)) {
        const hasToolResult = msg.content.some(b => b && b.type === 'tool_result');
        if (hasToolResult) {
          toolResultIndices.push(i);
          consecutiveToolTurns++;
        } else {
          // Reset consecutive count when user sends normal non-tool content
          consecutiveToolTurns = 0;
        }
      } else if (msg.role === 'user') {
        consecutiveToolTurns = 0;
      }
    }

    // 2. Check Circuit Breaker (too many consecutive automated turns)
    let circuitBreakerActivated = false;
    if (consecutiveToolTurns >= this.config.maxConsecutiveToolCalls) {
      circuitBreakerActivated = true;
      this.stats.circuitBreakerTriggered++;
    }

    // 3. Determine which tool results are "recent" vs "older"
    // Keep the most recent N tool turns intact; older ones can be pruned aggressively
    const keepCount = Math.max(1, this.config.keepRecentToolTurns);
    const recentIndicesSet = new Set(toolResultIndices.slice(-keepCount));

    // 4. Process each message
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;

      const isOlderTurn = !recentIndicesSet.has(i) && toolResultIndices.includes(i);

      for (let b = 0; b < msg.content.length; b++) {
        const block = msg.content[b];
        if (!block || block.type !== 'tool_result') continue;

        // Process block content (can be string or array of text blocks)
        if (typeof block.content === 'string') {
          if (isOlderTurn && block.content.length > 300) {
            // Aggressive prune for older turns
            const lines = block.content.split('\n');
            const summary = lines.slice(0, 3).join('\n');
            const originalLength = block.content.length;
            block.content = `${summary}\n[... claude-guard: ${originalLength} caracteres de saída anterior compactados ...]`;
            this.stats.prunedToolResults++;
          } else {
            // Standard truncation for recent or shorter turns
            const res = this.truncateText(block.content, this.config.maxToolResultChars);
            if (res.truncated) {
              block.content = res.text;
              this.stats.truncatedToolResults++;
            }
          }
        } else if (Array.isArray(block.content)) {
          for (let sub of block.content) {
            if (sub && typeof sub.text === 'string') {
              if (isOlderTurn && sub.text.length > 300) {
                const lines = sub.text.split('\n');
                const summary = lines.slice(0, 3).join('\n');
                const originalLength = sub.text.length;
                sub.text = `${summary}\n[... claude-guard: ${originalLength} caracteres de saída anterior compactados ...]`;
                this.stats.prunedToolResults++;
              } else {
                const res = this.truncateText(sub.text, this.config.maxToolResultChars);
                if (res.truncated) {
                  sub.text = res.text;
                  this.stats.truncatedToolResults++;
                }
              }
            }
          }
        }

        // If circuit breaker triggered and this is the latest tool result, inject warning
        if (circuitBreakerActivated && i === toolResultIndices[toolResultIndices.length - 1]) {
          const warning = `\n\n[AVISO CRÍTICO - CLAUDE-GUARD CIRCUIT BREAKER]: Você já executou ${consecutiveToolTurns} ações de ferramentas consecutivas sem intervenção humana. PARE agora, resuma objetivamente o que já fez até aqui e peça confirmação ao usuário antes de continuar.`;
          if (typeof block.content === 'string') {
            block.content += warning;
          } else if (Array.isArray(block.content) && block.content.length > 0) {
            block.content[block.content.length - 1].text += warning;
          }
        }
      }
    }

    return circuitBreakerActivated;
  }

  /**
   * Optimize the API request body (supports Anthropic and OpenAI formats)
   */
  optimize(payload, formatHint = null) {
    this.stats.totalRequests++;

    const isResponses = formatHint === 'openai' && Array.isArray(payload?.input);
    if (!payload || (!Array.isArray(payload.messages) && !isResponses) || (Array.isArray(payload.messages) && payload.messages.length === 0 && !isResponses)) {
      return { payload, stats: { ...this.stats }, modified: false, savedChars: 0, savedTokens: 0 };
    }

    const originalJson = JSON.stringify(payload);
    const originalLen = originalJson.length;
    this.stats.totalOriginalChars += originalLen;

    const isOpenAI = formatHint === 'openai' || this.detectIsOpenAI(payload);

    let circuitBreakerActivated = false;
    if (isResponses) {
      circuitBreakerActivated = this.optimizeOpenAIResponses(payload);
    } else if (isOpenAI) {
      circuitBreakerActivated = this.optimizeOpenAI(payload);
    } else {
      circuitBreakerActivated = this.optimizeAnthropic(payload);
    }

    const optimizedJson = JSON.stringify(payload);
    const optimizedLen = optimizedJson.length;
    this.stats.totalOptimizedChars += optimizedLen;

    const savedChars = Math.max(0, originalLen - optimizedLen);
    this.stats.charsSaved += savedChars;
    this.stats.estimatedTokensSaved += Math.round(savedChars / 3.8);

    return {
      payload,
      modified: savedChars > 0 || circuitBreakerActivated,
      savedChars,
      savedTokens: Math.round(savedChars / 3.8),
      circuitBreakerActivated,
      stats: { ...this.stats }
    };
  }

  getSummary() {
    const pct = this.stats.totalOriginalChars > 0
      ? ((this.stats.charsSaved / this.stats.totalOriginalChars) * 100).toFixed(1)
      : '0.0';
    return {
      ...this.stats,
      reductionPercent: `${pct}%`
    };
  }
}
