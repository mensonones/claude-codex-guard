import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createProxyServer } from '../src/proxy.js';

test('Proxy intercepts /v1/messages, optimizes body, and streams response', async () => {
  let receivedBody = null;
  const mockAnthropic = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      receivedBody = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
      res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    });
  });

  await new Promise(resolve => mockAnthropic.listen(0, '127.0.0.1', resolve));
  const mockPort = mockAnthropic.address().port;

  const { server: proxyServer, optimizer } = createProxyServer({
    targetHost: '127.0.0.1',
    targetPort: mockPort,
    maxToolResultChars: 400,
    dbPath: ':memory:'
  });

  await new Promise(resolve => proxyServer.listen(0, '127.0.0.1', resolve));
  const proxyPort = proxyServer.address().port;

  const bigOutput = 'X'.repeat(3000);
  const outgoingPayload = {
    model: 'claude-3-7-sonnet-20250219',
    messages: [
      { role: 'user', content: 'test' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'cmd_1', name: 'Bash', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'cmd_1', content: bigOutput }] }
    ]
  };

  const responseChunks = [];
  await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: proxyPort,
      path: '/v1/messages',
      method: 'POST',
      headers: { 'content-type': 'application/json' }
    }, res => {
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers['content-type'], 'text/event-stream');
      res.on('data', c => responseChunks.push(c));
      res.on('end', resolve);
    });
    req.on('error', reject);
    req.write(JSON.stringify(outgoingPayload));
    req.end();
  });

  assert.ok(receivedBody, 'Mock Anthropic should receive body');
  const receivedContent = receivedBody.messages[2].content[0].content;
  assert.ok(receivedContent.includes('claude-codex-guard:'));
  assert.ok(receivedContent.length < 600);
  assert.ok(optimizer.stats.estimatedTokensSaved > 500);

  const streamOutput = Buffer.concat(responseChunks).toString('utf-8');
  assert.ok(streamOutput.includes('message_start'));
  assert.ok(streamOutput.includes('message_stop'));

  await new Promise(resolve => proxyServer.close(resolve));
  await new Promise(resolve => mockAnthropic.close(resolve));
});

test('Proxy intercepts and blocks telemetry requests without contacting upstream', async () => {
  const { server: proxyServer, optimizer } = createProxyServer({
    targetHost: '127.0.0.1',
    targetPort: 9999, // intentionally unreachable if forwarded
    dbPath: ':memory:'
  });

  await new Promise(resolve => proxyServer.listen(0, '127.0.0.1', resolve));
  const proxyPort = proxyServer.address().port;

  const req = http.request({
    hostname: '127.0.0.1',
    port: proxyPort,
    path: '/v1/metrics',
    method: 'POST',
    headers: { 'content-type': 'application/json' }
  }, res => {
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['x-claude-codex-guard-blocked'], 'true');
    assert.equal(res.headers['x-claude-codex-guard-upstream'], 'aborted-locally');
    const chunks = [];
    res.on('data', c => chunks.push(c));
    res.on('end', () => {
      const data = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
      assert.equal(data.status, 'ok');
      assert.equal(data.blocked_by, 'claude-codex-guard');
      assert.equal(data.upstream_forwarded, false);
      assert.equal(optimizer.stats.telemetryBlocked, 1);
    });
  });

  req.write(JSON.stringify({ metric: 'cpu', value: 10 }));
  req.end();

  await new Promise(resolve => setTimeout(resolve, 50));

  // Check /claude-codex-guard/telemetry endpoint
  const telemetryRes = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${proxyPort}/claude-codex-guard/telemetry`, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(data) }));
    }).on('error', reject);
  });

  assert.equal(telemetryRes.status, 200);
  assert.ok(Array.isArray(telemetryRes.data.summary));
  assert.equal(telemetryRes.data.summary.length, 1);
  assert.equal(telemetryRes.data.summary[0].endpoint, '/v1/metrics');
  assert.equal(telemetryRes.data.summary[0].blocked_count, 1);

  await new Promise(resolve => proxyServer.close(resolve));
});

test('Proxy serves dashboard HTML on / and /dashboard', async () => {
  const { server: proxyServer } = createProxyServer({
    targetHost: '127.0.0.1',
    targetPort: 9999,
    dbPath: ':memory:'
  });

  await new Promise(resolve => proxyServer.listen(0, '127.0.0.1', resolve));
  const proxyPort = proxyServer.address().port;

  for (const path of ['/', '/dashboard']) {
    const res = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${proxyPort}${path}`, res => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, data }));
      }).on('error', reject);
    });

    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type'].includes('text/html'));
    assert.ok(res.data.includes('Claude-Codex-Guard'));
    assert.ok(res.data.includes('Dashboard'));
  }

  // Also test /claude-codex-guard/recent endpoint
  const recentRes = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${proxyPort}/claude-codex-guard/recent`, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(data) }));
    }).on('error', reject);
  });

  assert.equal(recentRes.status, 200);
  assert.ok(Array.isArray(recentRes.data));

  await new Promise(resolve => proxyServer.close(resolve));
});

