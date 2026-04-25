import type { AllowlistConfig } from '../config/schemas';

export function allowlistAllows(cfg: AllowlistConfig, phoneE164: string): boolean {
  switch (cfg.mode) {
    case 'open':
      return true;
    case 'explicit':
      return cfg.explicit_phones.includes(phoneE164);
    case 'rule':
      return cfg.rule.country_codes.some((cc) => phoneE164.startsWith(cc));
  }
}
