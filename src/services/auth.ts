import { createHmac, randomBytes } from 'node:crypto';
import cookie from 'cookie';
import type { Request, Response, NextFunction } from 'express';
import { config } from '../config.js';
import { HttpError } from '../utils/httpError.js';
import { safeEqual } from '../utils/hash.js';

const cookieName = 'line_dashboard_session';
const maxAgeSeconds = 8 * 60 * 60;

function sign(payload: string): string {
  return createHmac('sha256', config.SESSION_SECRET).update(payload).digest('base64url');
}

function createToken(): string {
  const expiresAt = Date.now() + maxAgeSeconds * 1000;
  const nonce = randomBytes(12).toString('base64url');
  const payload = `${expiresAt}.${nonce}`;
  return `${payload}.${sign(payload)}`;
}

function verifyToken(token = ''): boolean {
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [expiresAt, nonce, signature] = parts;
  if (Number(expiresAt) < Date.now()) return false;
  return safeEqual(signature, sign(`${expiresAt}.${nonce}`));
}

export function login(password: string): string {
  if (!safeEqual(password, config.DASHBOARD_PASSWORD)) {
    throw new HttpError(401, '密碼錯誤');
  }
  return createToken();
}

export function setSessionCookie(res: Response, token: string): void {
  res.setHeader(
    'Set-Cookie',
    cookie.serialize(cookieName, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.NODE_ENV === 'production',
      maxAge: maxAgeSeconds,
      path: '/'
    })
  );
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  const cookies = cookie.parse(req.headers.cookie ?? '');
  if (!verifyToken(cookies[cookieName])) {
    next(new HttpError(401, '請先登入'));
    return;
  }
  next();
}
