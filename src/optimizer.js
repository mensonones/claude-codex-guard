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
   * Optimize the Anthropic API request body
   */
  optimize(payload) {
    this.stats.totalRequests++;

    if (!payload || !Array.isArray(payload.messages) || payload.messages.length === 0) {
      return { payload, stats: { ...this.stats }, modified: false };
    }

    const originalJson = JSON.stringify(payload);
    const originalLen = originalJson.length;
    this.stats.totalOriginalChars += originalLen;

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
