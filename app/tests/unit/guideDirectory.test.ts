import { describe, it, expect } from 'vitest';
import { resolveGuidePhone, parseGuideNames, resolveGuidePhones } from '../../src/messaging/guideDirectory.js';
import type { GuidesConfig } from '../../src/config/schemas.js';

const guides: GuidesConfig = {
  guides: [
    { name: 'ליאנה', phone: '+34651886491', active: true },
    { name: 'עדי', phone: '+34669705817', active: true },
    { name: 'אדיר', phone: '+34604397498', active: true },
    { name: 'לא פעיל', phone: '+34600000000', active: false },
  ],
};

describe('resolveGuidePhone', () => {
  it('resolves an exact, active guide name', () => {
    expect(resolveGuidePhone(guides, 'ליאנה')).toBe('+34651886491');
  });

  it('returns null for an unknown name', () => {
    expect(resolveGuidePhone(guides, 'נעמי')).toBeNull();
  });

  it('returns null for an inactive guide', () => {
    expect(resolveGuidePhone(guides, 'לא פעיל')).toBeNull();
  });

  it('returns null for undefined/null/empty input', () => {
    expect(resolveGuidePhone(guides, undefined)).toBeNull();
    expect(resolveGuidePhone(guides, null)).toBeNull();
    expect(resolveGuidePhone(guides, '')).toBeNull();
  });
});

describe('parseGuideNames', () => {
  it('splits a slash-separated multi-guide string', () => {
    expect(parseGuideNames('ליאנה/עדי')).toEqual(['ליאנה', 'עדי']);
  });

  it('splits a slash-with-space multi-guide string, trimming whitespace', () => {
    expect(parseGuideNames('ליאנה/ עדי')).toEqual(['ליאנה', 'עדי']);
  });

  it('splits a comma-separated multi-guide string', () => {
    expect(parseGuideNames('ליאנה, עדי')).toEqual(['ליאנה', 'עדי']);
  });

  it('returns a single-element array for a single guide name', () => {
    expect(parseGuideNames('אדיר')).toEqual(['אדיר']);
  });

  it('returns an empty array for null/undefined/empty', () => {
    expect(parseGuideNames(null)).toEqual([]);
    expect(parseGuideNames(undefined)).toEqual([]);
    expect(parseGuideNames('')).toEqual([]);
  });
});

describe('resolveGuidePhones', () => {
  it('resolves every guide in a multi-guide string to its phone', () => {
    expect(resolveGuidePhones(guides, 'ליאנה/עדי')).toEqual(['+34651886491', '+34669705817']);
  });

  it('resolves a single-guide string the same as resolveGuidePhone', () => {
    expect(resolveGuidePhones(guides, 'אדיר')).toEqual(['+34604397498']);
  });

  it('drops names that fail to resolve, keeping the ones that do', () => {
    expect(resolveGuidePhones(guides, 'ליאנה/נעמי')).toEqual(['+34651886491']);
  });

  it('returns an empty array when nothing resolves', () => {
    expect(resolveGuidePhones(guides, 'נעמי')).toEqual([]);
    expect(resolveGuidePhones(guides, null)).toEqual([]);
  });
});
