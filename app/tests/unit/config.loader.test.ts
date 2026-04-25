import { describe, it, expect } from 'vitest';
import { loadConfig } from '../../src/config/loader.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const validDir = path.resolve(__dirname, '../fixtures/config-valid');

describe('loadConfig', () => {
  it('loads and validates a valid config directory', () => {
    const cfg = loadConfig(validDir);
    expect(cfg.groups.groups).toHaveLength(1);
    expect(cfg.tours.tours['gaudi-modernista']?.emoji).toBe('🌻');
    expect(cfg.settings.broadcast.mode).toBe('test');
    expect(cfg.allowlist.mode).toBe('explicit');
    expect(cfg.templates.night_header).toContain('night');
  });

  it('throws when a required file is missing', () => {
    expect(() => loadConfig('/does/not/exist')).toThrow();
  });
});
