import { describe, it, expect } from 'vitest';
import { allowlistAllows } from '../../src/messaging/allowlistGate.js';
import type { AllowlistConfig } from '../../src/config/schemas.js';

const explicit: AllowlistConfig = {
  mode: 'explicit',
  explicit_phones: ['+972501234567'],
  rule: { country_codes: [] },
};

const rule: AllowlistConfig = {
  mode: 'rule',
  explicit_phones: [],
  rule: { country_codes: ['+972', '+34'] },
};

const open: AllowlistConfig = {
  mode: 'open',
  explicit_phones: [],
  rule: { country_codes: [] },
};

describe('allowlistAllows', () => {
  it('explicit: allows listed, denies others', () => {
    expect(allowlistAllows(explicit, '+972501234567')).toBe(true);
    expect(allowlistAllows(explicit, '+34600111222')).toBe(false);
  });
  it('rule: allows matching country code', () => {
    expect(allowlistAllows(rule, '+972501234567')).toBe(true);
    expect(allowlistAllows(rule, '+34600111222')).toBe(true);
    expect(allowlistAllows(rule, '+10000000000')).toBe(false);
  });
  it('open: allows all', () => {
    expect(allowlistAllows(open, '+10000000000')).toBe(true);
  });
});
