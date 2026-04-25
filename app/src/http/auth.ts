import type { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcrypt';
import { createHmac, timingSafeEqual } from 'node:crypto';

const COOKIE_NAME = 'wabot_admin';
const MAX_COOKIE_AGE_MS = 7 * 24 * 3600 * 1000;

export interface AuthOpts {
  passwordHash: string;
  cookieSecret: string;
}

function sign(value: string, secret: string): string {
  const sig = createHmac('sha256', secret).update(value).digest('hex');
  return Buffer.from(`${value}.${sig}`).toString('base64url');
}

function verify(signed: string, secret: string): string | null {
  try {
    const decoded = Buffer.from(signed, 'base64url').toString('utf8');
    const sepIdx = decoded.lastIndexOf('.');
    if (sepIdx <= 0) return null;
    const value = decoded.slice(0, sepIdx);
    const sig = decoded.slice(sepIdx + 1);
    const expected = createHmac('sha256', secret).update(value).digest('hex');
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(sig, 'hex');
    if (a.length !== b.length) return null;
    if (!timingSafeEqual(a, b)) return null;
    const parts = value.split(':');
    if (parts.length !== 2 || parts[0] !== 'admin') return null;
    const ts = Number(parts[1]);
    if (!Number.isFinite(ts) || Date.now() - ts > MAX_COOKIE_AGE_MS) return null;
    return value;
  } catch {
    return null;
  }
}

export function createAuth(opts: AuthOpts) {
  async function login(password: string): Promise<string | null> {
    if (!opts.passwordHash) return null;
    const ok = await bcrypt.compare(password, opts.passwordHash);
    if (!ok) return null;
    return sign(`admin:${Date.now()}`, opts.cookieSecret);
  }

  function requireAuth(req: Request, res: Response, next: NextFunction) {
    const cookie = (req as Request & { cookies: Record<string, string> }).cookies?.[COOKIE_NAME];
    if (!cookie || !verify(cookie, opts.cookieSecret)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  }

  return { login, requireAuth, COOKIE_NAME };
}
