import { env } from '../config/env.js';
import * as authService from '../services/auth.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { sendSuccess, sendNoContent } from '../utils/ApiResponse.js';

/**
 * Cookie options for the staff session token.
 *
 * `httpOnly` is the point of the whole exercise: script on the page cannot read
 * this value, so an XSS bug cannot walk off with a shift's session the way it
 * could with a token in `localStorage`.
 *
 * `secure` is forced on whenever SameSite is `none`, because browsers drop a
 * `None` cookie that is not also `Secure`.
 */
const cookieOptions = {
  httpOnly: true,
  secure: env.isProduction || env.cookieSameSite === 'none',
  sameSite: env.cookieSameSite,
  maxAge: 12 * 60 * 60 * 1000,
  path: '/',
  ...(env.cookieDomain ? { domain: env.cookieDomain } : {}),
};

/** POST /auth/login — PIN login on a shared device. */
export const login = asyncHandler(async (req, res) => {
  const { phone, pin } = req.body as { phone: string; pin: string };
  const result = await authService.login(phone, pin, req.ip ?? null);

  // The cookie is what the browser apps authenticate with; they never read the
  // token. It is still returned in the body for native/WebView clients that
  // cannot rely on a cookie jar — see `extractToken` in authMiddleware.
  res.cookie(env.cookieName, result.token, cookieOptions);
  return sendSuccess(res, result, `Welcome, ${result.user.name}`);
});

/** POST /auth/logout */
export const logout = asyncHandler((_req, res) => {
  res.clearCookie(env.cookieName, { ...cookieOptions, maxAge: undefined });
  return sendNoContent(res);
});

/** GET /auth/me — used by every frontend on boot to restore its role UI. */
export const me = asyncHandler(async (req, res) => {
  const user = await authService.getProfile(req.user!.id);
  return sendSuccess(res, {
    id: String(user._id),
    name: user.name,
    phone: user.phone,
    role: user.role,
    lastLoginAt: user.lastLoginAt,
  });
});
