import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Default cost per million input tokens for Claude 3.7 Sonnet is $3.00 USD
const PRICE_PER_MILLION_INPUT_TOKENS_USD = 3.00;

export class GuardDB {
  constructor(customPath = null) {
    if (customPath === ':memory:') {
      this.dbPath = ':memory:';
    } else {
      const configDir = path.resolve(process.env.HOME || '.', '.config/claude-codex-guard');
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }
      this.dbPath = customPath || path.resolve(configDir, 'history.db');
    }

    this.db = new DatabaseSync(this.dbPath);
    this.init();
  }

  init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_uuid TEXT UNIQUE NOT NULL,
        client_type TEXT NOT NULL DEFAULT 'cli',
        project_name TEXT NOT NULL DEFAULT 'Geral',
        project_path TEXT,
        telemetry_blocked INTEGER DEFAULT 0,
        started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_uuid TEXT,
        project_name TEXT NOT NULL DEFAULT 'Geral',
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        model TEXT,
        original_chars INTEGER DEFAULT 0,
        optimized_chars INTEGER DEFAULT 0,
        saved_chars INTEGER DEFAULT 0,
        saved_tokens INTEGER DEFAULT 0,
        truncated_count INTEGER DEFAULT 0,
        pruned_count INTEGER DEFAULT 0,
        circuit_breaker INTEGER DEFAULT 0,
        FOREIGN KEY (session_uuid) REFERENCES sessions(session_uuid)
      );

      CREATE INDEX IF NOT EXISTS idx_requests_session ON requests(session_uuid);
      CREATE INDEX IF NOT EXISTS idx_requests_timestamp ON requests(timestamp);

      CREATE TABLE IF NOT EXISTS telemetry_blocks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_uuid TEXT,
        project_name TEXT NOT NULL DEFAULT 'Geral',
        endpoint TEXT NOT NULL,
        method TEXT NOT NULL DEFAULT 'POST',
        bytes_prevented INTEGER DEFAULT 0,
        upstream_blocked INTEGER DEFAULT 1,
        status_code INTEGER DEFAULT 200,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (session_uuid) REFERENCES sessions(session_uuid)
      );

      CREATE INDEX IF NOT EXISTS idx_telemetry_endpoint ON telemetry_blocks(endpoint);
      CREATE INDEX IF NOT EXISTS idx_telemetry_timestamp ON telemetry_blocks(timestamp);
    `);

    // Migrations for existing databases
    try { this.db.exec("ALTER TABLE sessions ADD COLUMN project_name TEXT NOT NULL DEFAULT 'Geral'"); } catch {}
    try { this.db.exec("ALTER TABLE sessions ADD COLUMN project_path TEXT"); } catch {}
    try { this.db.exec("ALTER TABLE sessions ADD COLUMN telemetry_blocked INTEGER DEFAULT 0"); } catch {}
    try { this.db.exec("ALTER TABLE requests ADD COLUMN project_name TEXT NOT NULL DEFAULT 'Geral'"); } catch {}
    try { this.db.exec("CREATE INDEX IF NOT EXISTS idx_requests_project ON requests(project_name)"); } catch {}
  }

  logTelemetryBlock({
    sessionUuid = null,
    projectName = 'Geral',
    endpoint = '/v1/metrics',
    method = 'POST',
    bytesPrevented = 0,
    statusCode = 200
  } = {}) {
    try {
      this.db.prepare(`
        INSERT INTO telemetry_blocks (
          session_uuid, project_name, endpoint, method, bytes_prevented, upstream_blocked, status_code
        ) VALUES (?, ?, ?, ?, ?, 1, ?)
      `).run(sessionUuid, projectName, endpoint, method, bytesPrevented, statusCode);

      if (sessionUuid) {
        this.db.prepare(`
          UPDATE sessions 
          SET telemetry_blocked = COALESCE(telemetry_blocked, 0) + 1, updated_at = CURRENT_TIMESTAMP
          WHERE session_uuid = ?
        `).run(sessionUuid);
      }
    } catch (err) {
      console.error('[claude-codex-guard] Failed to log telemetry block:', err.message);
    }
  }

  logTelemetryBlocked(sessionUuid, endpoint = 'telemetry', bytesPrevented = 0) {
    this.logTelemetryBlock({ sessionUuid, endpoint, bytesPrevented });
  }

  getTelemetryStats() {
    return this.db.prepare(`
      SELECT 
        endpoint,
        method,
        COUNT(*) as blocked_count,
        COALESCE(SUM(bytes_prevented), 0) as total_bytes_saved,
        MAX(timestamp) as last_blocked_at
      FROM telemetry_blocks
      GROUP BY endpoint, method
      ORDER BY blocked_count DESC
    `).all();
  }

  getRecentTelemetryBlocks(limit = 40) {
    return this.db.prepare(`
      SELECT 
        id, session_uuid, project_name, endpoint, method,
        bytes_prevented, upstream_blocked, status_code, timestamp
      FROM telemetry_blocks
      ORDER BY id DESC
      LIMIT ?
    `).all(limit);
  }

  createSession(clientType = 'cli', projectName = 'Geral', projectPath = null) {
    const sessionUuid = crypto.randomUUID();
    const stmt = this.db.prepare(`
      INSERT INTO sessions (session_uuid, client_type, project_name, project_path)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(sessionUuid, clientType, projectName, projectPath);
    return sessionUuid;
  }

  updateSessionProject(sessionUuid, projectName, projectPath = null) {
    if (!sessionUuid || !projectName || projectName === 'Geral') return;
    this.db.prepare(`
      UPDATE sessions 
      SET project_name = ?, project_path = COALESCE(?, project_path), updated_at = CURRENT_TIMESTAMP 
      WHERE session_uuid = ?
    `).run(projectName, projectPath, sessionUuid);
  }

  logRequest({
    sessionUuid = null,
    projectName = 'Geral',
    model = 'unknown',
    originalChars = 0,
    optimizedChars = 0,
    savedChars = 0,
    savedTokens = 0,
    truncatedCount = 0,
    prunedCount = 0,
    circuitBreaker = 0
  }) {
    const stmt = this.db.prepare(`
      INSERT INTO requests (
        session_uuid, project_name, model, original_chars, optimized_chars,
        saved_chars, saved_tokens, truncated_count, pruned_count, circuit_breaker
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      sessionUuid,
      projectName,
      model,
      originalChars,
      optimizedChars,
      savedChars,
      savedTokens,
      truncatedCount,
      prunedCount,
      circuitBreaker ? 1 : 0
    );

    if (sessionUuid) {
      this.db.prepare(`
        UPDATE sessions SET updated_at = CURRENT_TIMESTAMP WHERE session_uuid = ?
      `).run(sessionUuid);
    }
  }

  getOverallStats(filterProject = null) {
    let sql = `
      SELECT 
        COUNT(*) as total_requests,
        COALESCE(SUM(original_chars), 0) as total_original_chars,
        COALESCE(SUM(optimized_chars), 0) as total_optimized_chars,
        COALESCE(SUM(saved_chars), 0) as total_saved_chars,
        COALESCE(SUM(saved_tokens), 0) as total_saved_tokens,
        COALESCE(SUM(truncated_count), 0) as total_truncated,
        COALESCE(SUM(pruned_count), 0) as total_pruned,
        COALESCE(SUM(circuit_breaker), 0) as total_loops_blocked
      FROM requests
    `;

    const params = [];
    if (filterProject) {
      sql += ` WHERE LOWER(project_name) = LOWER(?)`;
      params.push(filterProject);
    }

    const row = this.db.prepare(sql).get(...params);
    const telemetryRow = this.db.prepare(`
      SELECT COALESCE(SUM(telemetry_blocked), 0) as total_telemetry
      FROM sessions
    `).get();

    const savedTokens = Number(row.total_saved_tokens);
    const originalChars = Number(row.total_original_chars);
    const savedChars = Number(row.total_saved_chars);
    const reductionPercent = originalChars > 0 
      ? ((savedChars / originalChars) * 100).toFixed(1) 
      : '0.0';
    const estimatedUsdSaved = ((savedTokens / 1_000_000) * PRICE_PER_MILLION_INPUT_TOKENS_USD).toFixed(3);

    return {
      filterProject: filterProject || null,
      totalRequests: Number(row.total_requests),
      totalSavedTokens: savedTokens,
      totalSavedChars: savedChars,
      totalOriginalChars: originalChars,
      reductionPercent: `${reductionPercent}%`,
      estimatedUsdSaved: `$${estimatedUsdSaved}`,
      totalTruncated: Number(row.total_truncated),
      totalPruned: Number(row.total_pruned),
      totalLoopsBlocked: Number(row.total_loops_blocked),
      totalTelemetryBlocked: Number(telemetryRow.total_telemetry)
    };
  }

  getProjectStats() {
    const rows = this.db.prepare(`
      SELECT 
        COALESCE(project_name, 'Geral') as name,
        COUNT(*) as request_count,
        COALESCE(SUM(saved_tokens), 0) as tokens_saved,
        COALESCE(SUM(original_chars), 0) as orig_chars,
        COALESCE(SUM(saved_chars), 0) as sv_chars,
        COALESCE(SUM(circuit_breaker), 0) as loops_prevented
      FROM requests
      GROUP BY name
      ORDER BY tokens_saved DESC
    `).all();

    return rows.map(r => {
      const tokens = Number(r.tokens_saved || 0);
      const usd = ((tokens / 1_000_000) * PRICE_PER_MILLION_INPUT_TOKENS_USD).toFixed(3);
      const orig = Number(r.orig_chars || 0);
      const saved = Number(r.sv_chars || 0);
      const pct = orig > 0 ? ((saved / orig) * 100).toFixed(1) : '0.0';

      return {
        projectName: r.name,
        requestCount: Number(r.request_count),
        tokensSaved: tokens,
        reductionPercent: `${pct}%`,
        estimatedUsdSaved: `$${usd}`,
        loopsPrevented: Number(r.loops_prevented || 0)
      };
    });
  }

  getDailyStats(limitDays = 14, filterProject = null) {
    let sql = `
      SELECT 
        DATE(timestamp, 'localtime') as day,
        COUNT(*) as requests_count,
        SUM(saved_tokens) as tokens_saved,
        SUM(original_chars) as orig_chars,
        SUM(saved_chars) as sv_chars,
        SUM(circuit_breaker) as loops_prevented
      FROM requests
    `;

    const params = [];
    if (filterProject) {
      sql += ` WHERE LOWER(project_name) = LOWER(?)`;
      params.push(filterProject);
    }

    sql += `
      GROUP BY day
      ORDER BY day DESC
      LIMIT ?
    `;
    params.push(limitDays);

    const rows = this.db.prepare(sql).all(...params);

    return rows.map(r => {
      const tokens = Number(r.tokens_saved || 0);
      const usd = ((tokens / 1_000_000) * PRICE_PER_MILLION_INPUT_TOKENS_USD).toFixed(3);
      const orig = Number(r.orig_chars || 0);
      const saved = Number(r.sv_chars || 0);
      const pct = orig > 0 ? ((saved / orig) * 100).toFixed(1) : '0.0';

      return {
        date: r.day,
        requests: Number(r.requests_count),
        tokensSaved: tokens,
        reductionPercent: `${pct}%`,
        estimatedUsdSaved: `$${usd}`,
        loopsPrevented: Number(r.loops_prevented || 0)
      };
    });
  }

  getClientStats(filterProject = null) {
    let sql = `
      SELECT 
        COALESCE(s.client_type, 'unknown') as client_type,
        COUNT(r.id) as request_count,
        COALESCE(SUM(r.saved_tokens), 0) as tokens_saved
      FROM sessions s
      LEFT JOIN requests r ON r.session_uuid = s.session_uuid
    `;

    const params = [];
    if (filterProject) {
      sql += ` WHERE LOWER(COALESCE(r.project_name, s.project_name)) = LOWER(?)`;
      params.push(filterProject);
    }

    sql += ` GROUP BY client_type`;

    return this.db.prepare(sql).all(...params);
  }

  getRecentSessions(limit = 15) {
    const sql = `
      SELECT 
        s.id,
        s.session_uuid,
        s.client_type,
        s.project_name,
        s.project_path,
        COUNT(r.id) as request_count,
        COALESCE(SUM(r.saved_tokens), 0) as tokens_saved,
        COALESCE(SUM(r.saved_chars), 0) as chars_saved,
        COALESCE(SUM(r.original_chars), 0) as orig_chars,
        s.started_at,
        s.updated_at
      FROM sessions s
      LEFT JOIN requests r ON r.session_uuid = s.session_uuid
      GROUP BY s.session_uuid
      ORDER BY s.id DESC
      LIMIT ?
    `;
    const rows = this.db.prepare(sql).all(limit);
    return rows.map(r => ({
      id: r.id,
      sessionUuid: r.session_uuid,
      clientType: r.client_type,
      projectName: r.project_name,
      projectPath: r.project_path,
      requestCount: Number(r.request_count || 0),
      tokensSaved: Number(r.tokens_saved || 0),
      charsSaved: Number(r.chars_saved || 0),
      origChars: Number(r.orig_chars || 0),
      startedAt: r.started_at,
      updatedAt: r.updated_at
    }));
  }

  exportData(format = 'json', filterProject = null) {
    let sql = `
      SELECT 
        r.id, r.timestamp, r.project_name, r.model, s.client_type,
        r.original_chars, r.optimized_chars, r.saved_chars,
        r.saved_tokens, r.truncated_count, r.pruned_count, r.circuit_breaker
      FROM requests r
      LEFT JOIN sessions s ON r.session_uuid = s.session_uuid
    `;

    const params = [];
    if (filterProject) {
      sql += ` WHERE LOWER(r.project_name) = LOWER(?)`;
      params.push(filterProject);
    }
    sql += ` ORDER BY r.id DESC`;

    const rows = this.db.prepare(sql).all(...params);

    if (format === 'csv') {
      const headers = [
        'id', 'timestamp', 'project_name', 'model', 'client_type',
        'original_chars', 'optimized_chars', 'saved_chars',
        'saved_tokens', 'truncated_count', 'pruned_count', 'circuit_breaker'
      ];
      const lines = [headers.join(',')];
      for (const row of rows) {
        lines.push(headers.map(h => JSON.stringify(row[h] ?? '')).join(','));
      }
      return lines.join('\n');
    }

    return JSON.stringify(rows, null, 2);
  }

  clearHistory() {
    this.db.exec(`
      DELETE FROM requests;
      DELETE FROM telemetry_blocks;
      DELETE FROM sessions;
      VACUUM;
    `);
  }

  getRecentRequests(limit = 40) {
    return this.db.prepare(`
      SELECT 
        r.id, r.timestamp, r.project_name, r.model, s.client_type,
        r.original_chars, r.optimized_chars, r.saved_chars,
        r.saved_tokens, r.truncated_count, r.pruned_count, r.circuit_breaker
      FROM requests r
      LEFT JOIN sessions s ON r.session_uuid = s.session_uuid
      ORDER BY r.id DESC
      LIMIT ?
    `).all(limit);
  }

  close() {
    this.db.close();
  }
}
