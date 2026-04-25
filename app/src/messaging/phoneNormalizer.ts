export interface NormalizeOpts {
  defaultCountry?: string; // e.g. "+34" or "+972"
}

export function normalizePhone(input: string, opts: NormalizeOpts = {}): string | null {
  if (!input) return null;
  const cleaned = input.replace(/[\s\-()]/g, '');
  if (/^\+\d{6,20}$/.test(cleaned)) return cleaned;
  if (/^\d{6,20}$/.test(cleaned)) {
    if (opts.defaultCountry) {
      const ccDigits = opts.defaultCountry.replace(/^\+/, '');
      if (cleaned.startsWith('0')) {
        return `${opts.defaultCountry}${cleaned.slice(1)}`;
      }
      if (cleaned.startsWith(ccDigits)) {
        return `+${cleaned}`;
      }
      return `${opts.defaultCountry}${cleaned}`;
    }
    return `+${cleaned}`;
  }
  return null;
}
