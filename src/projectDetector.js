import path from 'node:path';

/**
 * Cleans a detected path string, stripping punctuation and quotes
 */
function cleanPath(raw) {
  if (!raw) return null;
  return raw.replace(/^[\\"\\'\\`]+/, '').replace(/[\\"\\'\\`.,;:]+$/, '').trim();
}

/**
 * Extracts project name and path from system prompt or message tool arguments
 */
export function detectProjectFromPayload(payload) {
  if (!payload) return { projectName: 'Geral', projectPath: null };

  let textToScan = '';

  // 1. Scan system prompt
  if (typeof payload.system === 'string') {
    textToScan += ' ' + payload.system;
  } else if (Array.isArray(payload.system)) {
    for (const item of payload.system) {
      if (typeof item === 'string') textToScan += ' ' + item;
      else if (item && typeof item.text === 'string') textToScan += ' ' + item.text;
    }
  }

  // 2. Scan messages for file paths or commands
  if (Array.isArray(payload.messages)) {
    for (let i = 0; i < Math.min(8, payload.messages.length); i++) {
      const msg = payload.messages[i];
      if (msg.role === 'system' || msg.role === 'developer') {
        if (typeof msg.content === 'string') textToScan += ' ' + msg.content;
      }
      if (typeof msg.content === 'string') {
        textToScan += ' ' + msg.content;
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block && block.type === 'tool_use' && block.input) {
            if (block.input.path) textToScan += ' ' + block.input.path;
            if (block.input.file_path) textToScan += ' ' + block.input.file_path;
            if (block.input.command) textToScan += ' ' + block.input.command;
          }
          if (block && typeof block.text === 'string') {
            textToScan += ' ' + block.text;
          }
        }
      }

      // OpenAI tool_calls
      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          if (tc && tc.function && typeof tc.function.arguments === 'string') {
            textToScan += ' ' + tc.function.arguments;
          }
        }
      }
    }
  }

  // OpenAI Responses / ChatGPT backend uses `input` instead of `messages`.
  // Scan only the first few items to keep project detection cheap on large payloads.
  if (Array.isArray(payload.input)) {
    const collectInputText = (value, depth = 0) => {
      if (depth > 5 || value == null) return;
      if (typeof value === 'string') {
        textToScan += ' ' + value;
        return;
      }
      if (Array.isArray(value)) {
        for (const item of value.slice(0, 12)) collectInputText(item, depth + 1);
        return;
      }
      if (typeof value === 'object') {
        for (const [key, item] of Object.entries(value).slice(0, 20)) {
          if (['output', 'content', 'text', 'arguments', 'path', 'file_path', 'command', 'cwd'].includes(key)) {
            collectInputText(item, depth + 1);
          }
        }
      }
    };
    collectInputText(payload.input);
  }

  // Match explicit working directory / cwd pattern
  const cwdRegex = /(?:working directory|cwd|directory(?:\s+is)?):\s*([\/~][^\s\r\n\(\)\'\"]+)/i;
  const match = textToScan.match(cwdRegex);
  if (match && match[1]) {
    const rawPath = cleanPath(match[1]);
    if (rawPath) {
      const projectName = path.basename(rawPath);
      if (projectName && projectName !== '/' && projectName !== '~') {
        return { projectName, projectPath: rawPath };
      }
    }
  }

  // Match absolute dev paths like /home/user/dev/... or /home/user/workspace/...
  const devPathRegex = /(\/(?:home|Users)\/[^\/\s]+\/(?:dev|projects|workspace|code)\/[^\s\r\n\(\)\'\"]+)/i;
  const devMatch = textToScan.match(devPathRegex);
  if (devMatch && devMatch[1]) {
    let clean = cleanPath(devMatch[1]);
    // If it points to a file, take the parent directory
    if (path.extname(clean)) {
      clean = path.dirname(clean);
    }
    // If directory ends with generic folders like 'src', 'test', 'dist', go up one level
    let projectName = path.basename(clean);
    if (['src', 'test', 'tests', 'lib', 'dist', 'bin'].includes(projectName.toLowerCase())) {
      clean = path.dirname(clean);
      projectName = path.basename(clean);
    }

    if (projectName && projectName !== '/' && projectName !== '~') {
      return { projectName, projectPath: clean };
    }
  }

  return { projectName: 'Geral', projectPath: null };
}
