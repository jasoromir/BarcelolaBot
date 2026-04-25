import { describe, it, expect } from 'vitest';
import { loadConfig } from '../../src/config/loader';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('real config files', () => {
  it('loads without error', () => {
    const cfg = loadConfig(path.resolve(__dirname, '../../config'));
    expect(cfg.settings.timezone).toBe('Europe/Madrid');
  });
});
