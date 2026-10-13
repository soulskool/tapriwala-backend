import type { Request } from 'express';

import { env } from '../config/env.js';

/**
 * The staff session token on a request, wherever it rode in.
 *
 * Browser apps send the httpOnly cookie; native/WebView clients without a
 * cookie jar send `Authorization: Bearer`. One function, so `authenticate` and
 * the rate limiter can never disagree about who is asking.
 */
export function tokenFromRequest(req: Request): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    return header.slice(7).trim() || null;
  }
  const cookieToken = (req.cookies as Record<string, string> | undefined)?.[env.cookieName];
  // An empty cookie (a cleared session) is no token, not a token of "".
  return typeof cookieToken === 'string' && cookieToken.length > 0 ? cookieToken : null;
}

export default tokenFromRequest;
