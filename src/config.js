import fs from 'node:fs';
import path from 'node:path';

export const defaultConfig = {
  port: parseInt(process.env.CLAUDE_GUARD_PORT || '48080', 10),
  host: process.env.CLAUDE_GUARD_HOST || '127.0.0.1',
  targetHost: process.env.ANTHROPIC_TARGET_HOST || 'api.anthropic.com',
  targetPort: parseInt(process.env.ANTHROPIC_TARGET_PORT || '443', 10),
  openaiTargetHost: process.env.OPENAI_TARGET_HOST || 'api.openai.com',
  openaiTargetPort: parseInt(process.env.OPENAI_TARGET_PORT || '443', 10),
  codexTargetHost: process.env.CODEX_TARGET_HOST || 'chatgpt.com',
  codexTargetPort: parseInt(process.env.CODEX_TARGET_PORT || '443', 10),
  
  // Truncation limits for individual tool outputs
  maxToolResultChars: parseInt(process.env.CLAUDE_GUARD_MAX_TOOL_CHARS || '3500', 10),
  
  // How many recent tool turns to keep intact (older ones get heavily pruned)
  keepRecentToolTurns: parseInt(process.env.CLAUDE_GUARD_KEEP_TURNS || '2', 10),
  
  // Circuit breaker: max consecutive tool steps before forcing a stop/checkpoint
  maxConsecutiveToolCalls: parseInt(process.env.CLAUDE_GUARD_MAX_LOOPS || '12', 10),
  
  // Shims control
  enableShims: process.env.CLAUDE_GUARD_ENABLE_SHIMS !== 'false',
  
  // Verbose stats in terminal
  verbose: process.env.CLAUDE_GUARD_VERBOSE === 'true'
};

export function loadConfig(customPath = null) {
  const configFile = customPath || path.resolve(process.cwd(), 'claude-guard.config.json');
  if (fs.existsSync(configFile)) {
    try {
      const userConfig = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
      return { ...defaultConfig, ...userConfig };
    } catch (err) {
      console.error(`[claude-guard] Failed to parse config from ${configFile}:`, err.message);
    }
  }
  return { ...defaultConfig };
}
