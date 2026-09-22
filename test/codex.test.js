import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { TokenOptimizer } from '../src/optimizer.js';
import { defaultConfig } from '../src/config.js';
import { detectProjectFromPayload } from '../src/projectDetector.js';
import { createProxyServer } from '../src/proxy.js';

test('TokenOptimizer leaves simple OpenAI messages untouched', () => {
  const optimizer = new TokenOptimizer(defaultConfig);
  const payload = {
    model: 'gpt-5.6-luna',
    messages: [
      { role: 'system', content: 'You are an expert coder.' },
      { role: 'user', content: 'How do I optimize SQL?' }
    ]
  };

  const res = optimizer.optimize(payload, 'openai');
  assert.equal(res.modified, false);
  assert.equal(res.savedChars, 0);
  assert.equal(res.payload.messages[1].content, 'How do I optimize SQL?');
});

test('TokenOptimizer truncates excessively large OpenAI tool results', () => {
  const optimizer = new TokenOptimizer({ ...defaultConfig, maxToolResultChars: 500 });
  const massiveText = 'X'.repeat(6000);

  const payload = {
    model: 'gpt-5.6-luna',
    messages: [
      { role: 'user', content: 'run git diff' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{"cmd":"git diff"}' } }
        ]
      },
      {
        role: 'tool',
        tool_call_id: 'call_1',
        content: massiveText
      }
    ]
  };

  const res = optimizer.optimize(payload);
  assert.equal(res.modified, true);
  assert.ok(res.savedChars > 5000);
  assert.ok(res.savedTokens > 1200);

  const finalContent = res.payload.messages[2].content;
  assert.ok(finalContent.includes('claude-guard:'));
  assert.ok(finalContent.length <= 650);
});

test('TokenOptimizer truncates OpenAI Responses function_call_output items', () => {
  const optimizer = new TokenOptimizer({ ...defaultConfig, maxToolResultChars: 300 });
  const payload = {
    model: 'gpt-5.6-luna',
    input: [
      { role: 'user', content: 'run tests' },
      { type: 'function_call', call_id: 'call_1', name: 'bash', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'R'.repeat(2000) }
    ]
  };

  const result = optimizer.optimize(payload, 'openai');

  assert.equal(result.modified, true);
  assert.ok(result.savedTokens > 300);
  assert.ok(payload.input[2].output.includes('claude-guard:'));
  assert.ok(payload.input[2].output.length <= 300);
});

test('TokenOptimizer keeps parallel tool results from the same OpenAI turn intact', () => {
  const optimizer = new TokenOptimizer({ ...defaultConfig, keepRecentToolTurns: 1, maxToolResultChars: 2000 });
  const payload = {
    messages: [
      { role: 'user', content: 'run checks' },
      { role: 'assistant', tool_calls: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] },
      { role: 'tool', tool_call_id: 'a', content: 'A'.repeat(700) },
      { role: 'tool', tool_call_id: 'b', content: 'B'.repeat(700) },
      { role: 'tool', tool_call_id: 'c', content: 'C'.repeat(700) }
    ]
  };

  const result = optimizer.optimize(payload, 'openai');

  assert.equal(result.stats.prunedToolResults, 0);
  assert.equal(payload.messages[2].content, 'A'.repeat(700));
  assert.equal(payload.messages[3].content, 'B'.repeat(700));
  assert.equal(payload.messages[4].content, 'C'.repeat(700));
});

test('TokenOptimizer prunes older OpenAI tool turns aggressively while keeping recent intact', () => {
  const optimizer = new TokenOptimizer({
    ...defaultConfig,
    maxToolResultChars: 2000,
    keepRecentToolTurns: 1
  });

  const payload = {
    model: 'gpt-5.6-luna',
    messages: [
      { role: 'user', content: 'start task' },
      // Turn 1 (Old)
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'Header 1\nHeader 2\nHeader 3\n' + 'Old details '.repeat(100) },
      // Turn 2 (Recent)
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'bash', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_2', content: 'Recent content preserved: ' + 'Short '.repeat(5) }
    ]
  };

  const res = optimizer.optimize(payload);
  assert.equal(res.modified, true);

  // Turn 1 should be pruned
  const oldContent = res.payload.messages[2].content;
  assert.ok(oldContent.includes('saída anterior compactados'));

  // Turn 2 should remain intact
  const recentContent = res.payload.messages[4].content;
  assert.ok(recentContent.includes('Recent content preserved:'));
});

test('TokenOptimizer triggers circuit breaker when OpenAI consecutive loops exceed threshold', () => {
  const optimizer = new TokenOptimizer({
    ...defaultConfig,
    maxConsecutiveToolCalls: 3
  });

  const messages = [{ role: 'user', content: 'Fix test suite' }];
  for (let i = 1; i <= 4; i++) {
    messages.push({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: `call_${i}`, type: 'function', function: { name: 'bash', arguments: '{}' } }]
    });
    messages.push({
      role: 'tool',
      tool_call_id: `call_${i}`,
      content: `Result of step ${i}`
    });
  }

  const payload = { model: 'gpt-5.6-luna', messages };
  const res = optimizer.optimize(payload);

  assert.equal(res.circuitBreakerActivated, true);
  const lastToolResult = res.payload.messages[messages.length - 1].content;
  assert.ok(lastToolResult.includes('AVISO CRÍTICO - CODEX-GUARD CIRCUIT BREAKER'));
});

test('detectProjectFromPayload detects project from OpenAI developer/system prompt or tool arguments', () => {
  const payloadSystem = {
    messages: [
      { role: 'developer', content: 'Current working directory: /home/emerson-vieira/dev/opensource/argus' },
      { role: 'user', content: 'list files' }
    ]
  };
  assert.equal(detectProjectFromPayload(payloadSystem).projectName, 'argus');

  const payloadTools = {
    messages: [
      { role: 'user', content: 'check repo' },
      {
        role: 'assistant',
        tool_calls: [
          { function: { arguments: JSON.stringify({ cwd: '/home/emerson-vieira/dev/ssh-honeypot' }) } }
        ]
      }
    ]
  };
  assert.equal(detectProjectFromPayload(payloadTools).projectName, 'ssh-honeypot');
});

test('Proxy intercepts /v1/chat/completions, routes to OpenAI upstream, optimizes and logs', async () => {
  // 1. Create a mock OpenAI upstream server
  let upstreamReceivedBody = null;
  const mockUpstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      upstreamReceivedBody = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-test',
        choices: [{ message: { role: 'assistant', content: 'Done!' } }]
      }));
    });
  });

  await new Promise(resolve => mockUpstream.listen(0, '127.0.0.1', resolve));
  const upstreamPort = mockUpstream.address().port;

  // 2. Start proxy configured with mock upstream as openaiTargetPort
  const { server, db } = createProxyServer({
    port: 0,
    openaiTargetHost: '127.0.0.1',
    openaiTargetPort: upstreamPort,
    maxToolResultChars: 300,
    dbPath: ':memory:'
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const proxyPort = server.address().port;

  try {
    const hugeLog = 'L'.repeat(2000);
    const postData = JSON.stringify({
      model: 'gpt-5.6-luna',
      messages: [
        { role: 'user', content: 'Run test in /home/emerson-vieira/dev/opensource/claude-guard' },
        { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'run', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: hugeLog }
      ]
    });

    const res = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: proxyPort,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        }
      }, response => {
        let data = '';
        response.on('data', c => data += c);
        response.on('end', () => resolve({ statusCode: response.statusCode, body: data }));
      });
      req.on('error', reject);
      req.write(postData);
      req.end();
    });

    assert.equal(res.statusCode, 200);
    assert.ok(upstreamReceivedBody);
    assert.equal(upstreamReceivedBody.model, 'gpt-5.6-luna');
    // Content should have been truncated by optimizer
    const optimizedContent = upstreamReceivedBody.messages[2].content;
    assert.ok(optimizedContent.includes('claude-guard:'));
    assert.ok(optimizedContent.length < 500);

    // Verify DB recorded it under claude-guard project
    const stats = db.getOverallStats('claude-guard');
    assert.equal(stats.totalRequests, 1);
    assert.ok(stats.totalSavedTokens > 200);
  } finally {
    server.close();
    mockUpstream.close();
    db.close();
  }
});

test('Dashboard HTML includes Claude and Codex badges and agent section', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const html = fs.readFileSync(path.resolve(__dirname, '../src/dashboard.html'), 'utf-8');
  assert.ok(html.includes('badge-claude'));
  assert.ok(html.includes('badge-codex'));
  assert.ok(html.includes('id="agentList"'));
  assert.ok(html.includes('Por agente'));
});
