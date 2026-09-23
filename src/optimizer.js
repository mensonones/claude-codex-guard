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

    const replacement = `${head}\n\n[... output truncated: ${prunedCount} characters omitted for brevity ...]\n\n${tail}`;
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

    const maxLoops = this.config.maxConsecutiveToolCalls || 0;
    let circuitBreakerActivated = false;
    if (maxLoops > 0 && consecutiveToolTurns >= maxLoops) {
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
          msg.content = `${summary}\n[... older output truncated: ${originalLength} characters omitted ...]`;
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
              sub.text = `${summary}\n[... older output truncated: ${originalLength} characters omitted ...]`;
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
    }

    if (circuitBreakerActivated) {
      const notice = `\n\n[System Alert: You have performed ${consecutiveToolTurns} consecutive automated tool actions. Please pause, summarize your progress to the user, and ask for confirmation before executing further tool actions.]`;
      const sysMsg = messages.find(m => m.role === 'system' || m.role === 'developer');
      if (sysMsg) {
        if (typeof sysMsg.content === 'string') {
          sysMsg.content += notice;
        } else if (Array.isArray(sysMsg.content)) {
          sysMsg.content.push({ type: 'text', text: notice });
        }
      } else {
        messages.unshift({ role: 'system', content: notice.trim() });
      }
    }

    return circuitBreakerActivated;
  }

  optimizeOpenAIResponses(payload) {
    // Remove invalid assistant/message items with empty output arrays that cause
    // "model output must contain either output text or tool calls" API errors.
    if (Array.isArray(payload.input)) {
      for (let i = payload.input.length - 1; i >= 0; i--) {
        const item = payload.input[i];
        if (
          item &&
          (item.type === 'message' || item.role === 'assistant') &&
          Array.isArray(item.output) &&
          item.output.length === 0
        ) {
          payload.input.splice(i, 1);
        }
      }
    }

    const items = Array.isArray(payload.input) ? payload.input : [];
    const toolGroups = [];
    let activeGroup = null;
    let consecutiveToolTurns = 0;
    let lastWasFunctionCall = false;

    for (const item of items) {
      if (!item || typeof item !== 'object') continue;

      const isUser = item.role === 'user' || (item.type === 'message' && item.role === 'user');
      if (isUser) {
        consecutiveToolTurns = 0;
        activeGroup = null;
        lastWasFunctionCall = false;
        continue;
      }

      if (item.type === 'function_call') {
        if (!lastWasFunctionCall) {
          activeGroup = { outputs: [] };
          toolGroups.push(activeGroup);
          consecutiveToolTurns++;
        }
        lastWasFunctionCall = true;
      } else if (item.type === 'function_call_output') {
        lastWasFunctionCall = false;
        if (!activeGroup) {
          activeGroup = { outputs: [] };
          toolGroups.push(activeGroup);
          consecutiveToolTurns++;
        }
        if (typeof item.output === 'string') {
          activeGroup.outputs.push(item);
        }
      } else {
        lastWasFunctionCall = false;
      }
    }

    const maxLoops = this.config.maxConsecutiveToolCalls || 0;
    let circuitBreakerActivated = false;
    if (maxLoops > 0 && consecutiveToolTurns >= maxLoops) {
      circuitBreakerActivated = true;
      this.stats.circuitBreakerTriggered++;
    }

    const keepCount = Math.max(1, this.config.keepRecentToolTurns);
    const recentGroups = new Set(toolGroups.slice(-keepCount));

    for (const group of toolGroups) {
      const isOlderTurn = !recentGroups.has(group);
      for (const outputItem of group.outputs) {
        if (typeof outputItem.output !== 'string') continue;

        if (isOlderTurn && outputItem.output.length > 300) {
          const lines = outputItem.output.split('\n');
          const summary = lines.slice(0, 3).join('\n');
          const originalLength = outputItem.output.length;
          outputItem.output = `${summary}\n[... older output truncated: ${originalLength} characters omitted ...]`;
          this.stats.prunedToolResults++;
        } else {
          const res = this.truncateText(outputItem.output, this.config.maxToolResultChars);
          if (res.truncated) {
            outputItem.output = res.text;
            this.stats.truncatedToolResults++;
          }
        }
      }
    }

    if (circuitBreakerActivated) {
      const notice = `\n\n[System Alert: You have performed ${consecutiveToolTurns} consecutive automated tool actions. Please pause, summarize your progress to the user, and ask for confirmation before executing further tool actions.]`;
      const sysMsg = items.find(
        m => m && (m.role === 'system' || m.role === 'developer' || (m.type === 'message' && (m.role === 'system' || m.role === 'developer')))
      );
      if (sysMsg) {
        if (typeof sysMsg.content === 'string') {
          sysMsg.content += notice;
        } else if (Array.isArray(sysMsg.content)) {
          sysMsg.content.push({ type: 'text', text: notice });
        }
      } else if (typeof payload.instructions === 'string') {
        payload.instructions += notice;
      } else {
        payload.instructions = notice.trim();
      }
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

    // 2. Check Circuit Breaker (too many consecutive automated turns; 0 disables)
    const maxLoops = this.config.maxConsecutiveToolCalls || 0;
    let circuitBreakerActivated = false;
    if (maxLoops > 0 && consecutiveToolTurns >= maxLoops) {
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
            block.content = `${summary}\n[... older output truncated: ${originalLength} characters omitted ...]`;
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
                sub.text = `${summary}\n[... older output truncated: ${originalLength} characters omitted ...]`;
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
      }
    }

    if (circuitBreakerActivated) {
      const notice = `\n\n[System Alert: You have performed ${consecutiveToolTurns} consecutive automated tool actions. Please pause, summarize your progress to the user, and ask for confirmation before executing further tool actions.]`;
      if (!payload.system) {
        payload.system = notice.trim();
      } else if (typeof payload.system === 'string') {
        payload.system += notice;
      } else if (Array.isArray(payload.system)) {
        payload.system.push({ type: 'text', text: notice });
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
