import test from 'node:test';
import assert from 'node:assert/strict';
import { detectProjectFromPayload } from '../src/projectDetector.js';

test('detectProjectFromPayload detects project from system prompt cwd', () => {
  const payload = {
    system: 'Current working directory is /home/emerson-vieira/dev/justofood. Always write tests.',
    messages: []
  };

  const res = detectProjectFromPayload(payload);
  assert.equal(res.projectName, 'justofood');
  assert.equal(res.projectPath, '/home/emerson-vieira/dev/justofood');
});

test('detectProjectFromPayload detects project from home dev path in messages', () => {
  const payload = {
    system: 'You are an assistant',
    messages: [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: '1',
            name: 'Bash',
            input: { command: 'cat /home/emerson-vieira/dev/opensource/argus/README.md' }
          }
        ]
      }
    ]
  };

  const res = detectProjectFromPayload(payload);
  assert.equal(res.projectName, 'argus');
});

test('detectProjectFromPayload falls back to Geral if no path found', () => {
  const payload = {
    system: 'You are Claude.',
    messages: [{ role: 'user', content: 'What is 2+2?' }]
  };

  const res = detectProjectFromPayload(payload);
  assert.equal(res.projectName, 'Geral');
  assert.equal(res.projectPath, null);
});
