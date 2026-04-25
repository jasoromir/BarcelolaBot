import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { openDatabase } from '../../src/persistence/db';
import { EventLog } from '../../src/persistence/eventLog';
import { createLogger } from '../../src/log/logger';

describe('createLogger', () => {
  it('writes events to the SQLite sink', () => {
    const db = openDatabase(
      path.join(os.tmpdir(), `wabot-logger-${Date.now()}.sqlite`),
    );
    const eventLog = new EventLog(db);
    const log = createLogger({
      eventLog,
      logDir: path.join(os.tmpdir(), `wabot-logs-${Date.now()}`),
      consoleLevel: 'silent',
    });
    log.info({ source: 'test', eventType: 'hello', message: 'hi', metadata: { a: 1 } });
    const rows = eventLog.recent(5);
    expect(rows[0]?.event_type).toBe('hello');
    expect(rows[0]?.metadata).toEqual({ a: 1 });
  });
});
