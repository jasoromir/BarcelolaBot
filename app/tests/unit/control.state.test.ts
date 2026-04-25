import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { openDatabase } from '../../src/persistence/db.js';
import { ControlState } from '../../src/persistence/controlState.js';
import { ControlStateService } from '../../src/control/state.js';

function svc() {
  const db = openDatabase(
    path.join(os.tmpdir(), `wabot-cs-${Date.now()}-${Math.random()}.sqlite`),
  );
  return new ControlStateService(new ControlState(db));
}

describe('ControlStateService', () => {
  it('defaults to running', () => {
    expect(svc().isPaused()).toBe(false);
  });

  it('pause() persists and returns', () => {
    const s = svc();
    s.pause();
    expect(s.isPaused()).toBe(true);
    s.resume();
    expect(s.isPaused()).toBe(false);
  });
});
