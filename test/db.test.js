import test from 'node:test';
import assert from 'node:assert/strict';
import { GuardDB } from '../src/db.js';

test('GuardDB logs project_name and generates per-project stats', () => {
  const db = new GuardDB(':memory:');
  const session1 = db.createSession('desktop', 'justofood', '/home/emerson-vieira/dev/justofood');
  const session2 = db.createSession('cli', 'argus', '/home/emerson-vieira/dev/opensource/argus');

  // Request for justofood
  db.logRequest({
    sessionUuid: session1,
    projectName: 'justofood',
    model: 'claude-3-7-sonnet-20250219',
    originalChars: 10000,
    optimizedChars: 4000,
    savedChars: 6000,
    savedTokens: 1578,
    truncatedCount: 2,
    prunedCount: 1,
    circuitBreaker: 0
  });

  // Request for argus
  db.logRequest({
    sessionUuid: session2,
    projectName: 'argus',
    model: 'claude-3-7-sonnet-20250219',
    originalChars: 20000,
    optimizedChars: 8000,
    savedChars: 12000,
    savedTokens: 3157,
    truncatedCount: 1,
    prunedCount: 2,
    circuitBreaker: 1
  });

  // Check overall stats
  const overall = db.getOverallStats();
  assert.equal(overall.totalRequests, 2);
  assert.equal(overall.totalSavedTokens, 4735);

  // Check stats filtered by project
  const justofoodStats = db.getOverallStats('justofood');
  assert.equal(justofoodStats.totalRequests, 1);
  assert.equal(justofoodStats.totalSavedTokens, 1578);

  const argusStats = db.getOverallStats('argus');
  assert.equal(argusStats.totalRequests, 1);
  assert.equal(argusStats.totalSavedTokens, 3157);

  // Check project breakdown table
  const projectStats = db.getProjectStats();
  assert.equal(projectStats.length, 2);
  assert.equal(projectStats[0].projectName, 'argus'); // highest tokens saved first
  assert.equal(projectStats[0].tokensSaved, 3157);
  assert.equal(projectStats[1].projectName, 'justofood');
  assert.equal(projectStats[1].tokensSaved, 1578);

  db.close();
});

test('GuardDB logs telemetry blocks and calculates endpoint statistics', () => {
  const db = new GuardDB(':memory:');
  const session = db.createSession('desktop', 'justofood');

  db.logTelemetryBlock({
    sessionUuid: session,
    projectName: 'justofood',
    endpoint: '/v1/metrics',
    method: 'POST',
    bytesPrevented: 150
  });

  db.logTelemetryBlock({
    sessionUuid: session,
    projectName: 'justofood',
    endpoint: '/v1/metrics',
    method: 'POST',
    bytesPrevented: 200
  });

  db.logTelemetryBlock({
    sessionUuid: session,
    projectName: 'justofood',
    endpoint: '/v1/traces',
    method: 'POST',
    bytesPrevented: 450
  });

  const stats = db.getTelemetryStats();
  assert.equal(stats.length, 2);
  assert.equal(stats[0].endpoint, '/v1/metrics');
  assert.equal(stats[0].blocked_count, 2);
  assert.equal(stats[0].total_bytes_saved, 350);

  assert.equal(stats[1].endpoint, '/v1/traces');
  assert.equal(stats[1].blocked_count, 1);
  assert.equal(stats[1].total_bytes_saved, 450);

  const recent = db.getRecentTelemetryBlocks(10);
  assert.equal(recent.length, 3);
  assert.equal(recent[0].endpoint, '/v1/traces');
  assert.equal(recent[0].upstream_blocked, 1);
  assert.equal(recent[0].status_code, 200);

  const overall = db.getOverallStats();
  assert.equal(overall.totalTelemetryBlocked, 3);

  db.close();
});

