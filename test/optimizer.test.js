import test from 'node:test';
import assert from 'node:assert/strict';
import { TokenOptimizer } from '../src/optimizer.js';
import { defaultConfig } from '../src/config.js';

test('TokenOptimizer leaves simple text messages untouched', () => {
  const optimizer = new TokenOptimizer(defaultConfig);
  const payload = {
    model: 'claude-3-7-sonnet-20250219',
    messages: [{ role: 'user', content: 'Hello, how are you?' }]
  };

  const res = optimizer.optimize(payload);
  assert.equal(res.modified, false);
  assert.equal(res.savedChars, 0);
  assert.equal(res.payload.messages[0].content, 'Hello, how are you?');
});

test('TokenOptimizer truncates excessively large tool results', () => {
  const optimizer = new TokenOptimizer({ ...defaultConfig, maxToolResultChars: 500 });
  const massiveText = 'A'.repeat(5000);

  const payload = {
    model: 'claude-3-7-sonnet-20250219',
    messages: [
      { role: 'user', content: 'run command' },
      { role: 'assistant', content: [{ type: 'tool_use', id: '1', name: 'Bash', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: '1', content: massiveText }] }
    ]
  };

  const res = optimizer.optimize(payload);
  assert.equal(res.modified, true);
  assert.ok(res.savedChars > 4000);
  assert.ok(res.savedTokens > 1000);

  const finalContent = res.payload.messages[2].content[0].content;
  assert.ok(finalContent.includes('output truncated:'));
  assert.ok(finalContent.includes('characters omitted for brevity'));
  assert.ok(finalContent.length <= 650);
});

test('TokenOptimizer prunes older tool turns aggressively while keeping recent ones intact', () => {
  const optimizer = new TokenOptimizer({
    ...defaultConfig,
    maxToolResultChars: 2000,
    keepRecentToolTurns: 1 // only keep the 1 latest turn intact
  });

  const payload = {
    model: 'claude-3-7-sonnet-20250219',
    messages: [
      { role: 'user', content: 'start' },
      // Turn 1 (Old)
      { role: 'assistant', content: [{ type: 'tool_use', id: '1', name: 'Bash', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: '1', content: 'Line 1\nLine 2\nLine 3\n' + 'Old details '.repeat(100) }] },
      // Turn 2 (Recent)
      { role: 'assistant', content: [{ type: 'tool_use', id: '2', name: 'Bash', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: '2', content: 'Recent content that is preserved: ' + 'Short'.repeat(5) }] }
    ]
  };

  const res = optimizer.optimize(payload);
  assert.equal(res.modified, true);
  
  // Turn 1 should be pruned
  const oldContent = res.payload.messages[2].content[0].content;
  assert.ok(oldContent.includes('characters omitted'));

  // Turn 2 should remain intact
  const recentContent = res.payload.messages[4].content[0].content;
  assert.ok(recentContent.includes('Recent content that is preserved:'));
});

test('TokenOptimizer triggers circuit breaker in system prompt when loops exceed threshold', () => {
  const optimizer = new TokenOptimizer({
    ...defaultConfig,
    maxConsecutiveToolCalls: 3
  });

  const messages = [{ role: 'user', content: 'Fix the bug' }];
  for (let i = 1; i <= 4; i++) {
    messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: `${i}`, name: 'Bash', input: {} }] });
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `${i}`, content: `Step ${i} result` }] });
  }

  const payload = { model: 'claude-3-7-sonnet-20250219', messages };
  const res = optimizer.optimize(payload);

  assert.equal(res.circuitBreakerActivated, true);
  const systemText = typeof res.payload.system === 'string'
    ? res.payload.system
    : res.payload.system?.[0]?.text;
  assert.ok(systemText && systemText.includes('System Alert: You have performed 4 consecutive automated tool actions'));
  // Ensure tool_result was NOT polluted with instructions
  const lastToolResult = res.payload.messages[messages.length - 1].content[0].content;
  assert.equal(lastToolResult, 'Step 4 result');
});

test('TokenOptimizer does not trigger circuit breaker when disabled with 0', () => {
  const optimizer = new TokenOptimizer({
    ...defaultConfig,
    maxConsecutiveToolCalls: 0
  });

  const messages = [{ role: 'user', content: 'Fix the bug' }];
  for (let i = 1; i <= 10; i++) {
    messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: `${i}`, name: 'Bash', input: {} }] });
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `${i}`, content: `Step ${i} result` }] });
  }

  const payload = { model: 'claude-3-7-sonnet-20250219', messages };
  const res = optimizer.optimize(payload);

  assert.equal(res.circuitBreakerActivated, false);
  assert.equal(res.payload.system, undefined);
});
