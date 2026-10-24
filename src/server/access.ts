import {createHash, randomBytes, timingSafeEqual} from 'node:crypto';
import type {IncomingMessage} from 'node:http';

const digest = (value: string) => createHash('sha256').update(value).digest();
export const equal = (left: string, right: string) => timingSafeEqual(digest(left), digest(right));

export function access(admin: string, password: string, apiToken: string) {
  const sessions = new Map<string, number>();
  const attempts = new Map<string, {count: number; until: number}>();
  const ttl = 8 * 60 * 60 * 1000;
  return {
    login(user: string, secret: string, address: string): string {
      const now = Date.now();
      for (const [key, expiry] of sessions) { if (expiry < now) { sessions.delete(key); } }
      for (const [key, attempt] of attempts) { if (attempt.until < now) { attempts.delete(key); } }
      const attempt = attempts.get(address) ?? {count: 0, until: now + 60_000};
      if (attempt.count >= 10 || attempts.size > 10_000) { throw new Error('Too many login attempts; retry in one minute'); }
      attempt.count += 1;
      attempts.set(address, attempt);
      if (!equal(user, admin) || !equal(secret, password)) { throw new Error('Invalid account or password'); }
      attempts.delete(address);
      const token = randomBytes(32).toString('hex');
      sessions.set(token, now + ttl);
      return token;
    },
    authorized(request: IncomingMessage): boolean {
      if (equal(request.headers.authorization ?? '', `Bearer ${apiToken}`)) { return true; }
      const cookie = request.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith('tunnel_session='));
      return (sessions.get(cookie?.slice('tunnel_session='.length) ?? '') ?? 0) > Date.now();
    },
    logout(request: IncomingMessage): void {
      const cookie = request.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith('tunnel_session='));
      sessions.delete(cookie?.slice('tunnel_session='.length) ?? '');
    },
  };
}
