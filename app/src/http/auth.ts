import type { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcrypt';
import { createHmac } from 'node:crypto';

const COOKIE_NAME = 'wabot_admin';

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
    if (expected !== sig) return null;
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
