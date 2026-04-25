import { describe, it, expect } from 'vitest';
import { normalizePhone } from '../../src/messaging/phoneNormalizer';

describe('normalizePhone', () => {
  it('passes through valid +CC format', () => {
    expect(normalizePhone('+972501234567')).toBe('+972501234567');
  });
  it('strips spaces and dashes', () => {
    expect(normalizePhone('+972 50-123 4567')).toBe('+972501234567');
  });
  it('adds + if missing but starts with country code digits', () => {
    expect(normalizePhone('972501234567', { defaultCountry: '+972' })).toBe('+972501234567');
  });
  it('prepends default country code for local numbers starting with 0', () => {
    expect(normalizePhone('0501234567', { defaultCountry: '+972' })).toBe('+972501234567');
  });
  it('returns null on garbage input', () => {
    expect(normalizePhone('abc')).toBeNull();
  });
  it('returns null on too-short number', () => {
    expect(normalizePhone('+12')).toBeNull();
  });
});
