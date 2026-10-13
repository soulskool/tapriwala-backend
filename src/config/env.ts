import dotenv from 'dotenv';

dotenv.config();

/**
 * Typed, validated environment.
 *
 * Anything the app needs is read exactly once, here, and fails loudly at boot
 * rather than surfacing as `undefined` deep inside a request. Import `env`
 * everywhere instead of touching `process.env` directly.
 */

type NodeEnv = 'development' | 'production' | 'test';

const missing: string[] = [];
const invalid: string[] = [];

function required(key: string, fallback?: string): string {
  const value = process.env[key] ?? fallback;
  if (value === undefined || value.trim() === '') {
    missing.push(key);
    return '';
  }
  return value.trim();
}

function optional(key: string, fallback: string): string {
  const value = process.env[key];
  return value === undefined || value.trim() === '' ? fallback : value.trim();
}

function num(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    invalid.push(`${key} must be a number (got "${raw}")`);
    return fallback;
  }
  return parsed;
}

function list(key: string, fallback: string[]): string[] {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function oneOf<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  const raw = (process.env[key] ?? fallback).trim() as T;
  if (!allowed.includes(raw)) {
    invalid.push(`${key} must be one of ${allowed.join(' | ')} (got "${raw}")`);
    return fallback;
  }
  return raw;
}

function bool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = raw.trim().toLowerCase();
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  invalid.push(`${key} must be true or false (got "${raw}")`);
  return fallback;
}

const nodeEnv = oneOf<NodeEnv>('NODE_ENV', ['development', 'production', 'test'], 'development');
const corsOrigins = list('CORS_ORIGINS', ['http://localhost:3000']);
const cookieSameSite = oneOf<'lax' | 'strict' | 'none'>(
  'COOKIE_SAMESITE',
  ['lax', 'strict', 'none'],
  'lax',
);

export const env = {
  nodeEnv,
  isProduction: nodeEnv === 'production',
  isDevelopment: nodeEnv === 'development',
  isTest: nodeEnv === 'test',

  port: num('PORT', 5010),
  apiPrefix: optional('API_PREFIX', '/api/v1'),
  logLevel: optional('LOG_LEVEL', 'info'),

  mongoUri: required('MONGO_URI', 'mongodb://127.0.0.1:27017/acd_cafe'),

  jwtSecret: required('JWT_SECRET', nodeEnv === 'production' ? undefined : 'dev-only-secret'),
  jwtExpiresIn: optional('JWT_EXPIRES_IN', '12h'),
  cookieName: optional('COOKIE_NAME', 'acd_cafe_token'),

  /**
   * How the staff session cookie is scoped.
   *
   * `lax` is correct whenever the browser app and this API share a registrable
   * domain — `localhost:3000` → `localhost:5010` counts, because SameSite
   * compares sites and ignores the port, and so does `app.cafe.com` →
   * `api.cafe.com`.
   *
   * Only set `none` when the two are on genuinely different domains. It
   * requires HTTPS, which is why `secure` is forced on below.
   */
  cookieSameSite,
  /** Set to share one cookie across subdomains, e.g. `.cafe.com`. */
  cookieDomain: optional('COOKIE_DOMAIN', ''),
  /**
   * Whether the session cookie carries `Secure`.
   *
   * Defaults on whenever the deployment is evidently HTTPS — production, a
   * `none` cookie, or every allowed browser origin being https:// — so a
   * server that forgot `NODE_ENV=production` still never sends the staff
   * session over plain HTTP. Local http://localhost stays off.
   */
  cookieSecure: bool(
    'COOKIE_SECURE',
    nodeEnv === 'production' ||
      cookieSameSite === 'none' ||
      (corsOrigins.length > 0 && corsOrigins.every((origin) => origin.startsWith('https://'))),
  ),

  /**
   * Express `trust proxy` hop count. 1 = exactly one reverse proxy (nginx) in
   * front, which is what makes `req.ip` the real client for rate limiting and
   * the audit log. 0 = trust nothing (direct connections, local dev).
   */
  trustProxy: num('TRUST_PROXY', nodeEnv === 'production' ? 1 : 0),

  /**
   * Stack traces and raw 5xx messages in API responses. Off unless explicitly
   * asked for: they hand out server paths and library internals, and the full
   * error is always in the server log anyway.
   */
  exposeErrorDetails: bool('EXPOSE_ERROR_DETAILS', false),

  corsOrigins,
  customerBaseUrl: optional('CUSTOMER_BASE_URL', 'http://localhost:3000'),

  serviceRequestEscalationMinutes: num('SERVICE_REQUEST_ESCALATION_MINUTES', 5),
  readyOrderEscalationMinutes: num('READY_ORDER_ESCALATION_MINUTES', 5),
  sessionNumberReset: oneOf<'daily' | 'never'>('SESSION_NUMBER_RESET', ['daily', 'never'], 'daily'),
  defaultTaxPercent: num('DEFAULT_TAX_PERCENT', 5),

  rateLimitWindowMs: num('RATE_LIMIT_WINDOW_MINUTES', 15) * 60 * 1000,
  rateLimitMax: num('RATE_LIMIT_MAX', 50000),
  /** Per signed-in staff member, not per IP — the whole café shares one Wi-Fi IP. */
  rateLimitStaffMax: num('RATE_LIMIT_STAFF_MAX', 50000),

  // ── Storage (menu item images) ──
  storageDriver: oneOf<'local' | 'bunny'>('STORAGE_DRIVER', ['local', 'bunny'], 'local'),
  uploadDir: optional('UPLOAD_DIR', 'uploads'),
  uploadUrlPath: optional('UPLOAD_URL_PATH', '/uploads'),
  /** Origin this API is reachable on — used to build absolute image URLs. */
  publicBaseUrl: optional('PUBLIC_BASE_URL', `http://localhost:${num('PORT', 5010)}`),

  // ── Bunny.net storage (STORAGE_DRIVER=bunny) ──
  /** Write host, e.g. https://sg.storage.bunnycdn.com — needs the access key. */
  bunnyBaseUrl: optional('BUNNY_BASE_URL', 'https://storage.bunnycdn.com'),
  /** Public read host, e.g. https://<zone>.b-cdn.net — no key, cached. */
  bunnyCdnUrl: optional('BUNNY_CDN_URL', ''),
  bunnyStorageZone: optional('BUNNY_STORAGE_ZONE', ''),
  bunnyAccessKey: optional('BUNNY_ACCESS_KEY', ''),
  /** Prefix inside the zone — the zone is shared with another project. */
  bunnyFolder: optional('BUNNY_FOLDER', 'acd-cafe'),
  bunnyRegion: optional('BUNNY_REGION', ''),

  seedAdminPhone: optional('SEED_ADMIN_PHONE', '9999999999'),
  seedAdminPin: optional('SEED_ADMIN_PIN', '1234'),
} as const;

/**
 * Called from `server.ts` before anything else boots. Kept as a function (not a
 * module side effect) so tests can import `env` without killing the process.
 */
export function assertEnv(): void {
  const problems: string[] = [];
  if (missing.length > 0) problems.push(`Missing required env vars: ${missing.join(', ')}`);
  if (invalid.length > 0) problems.push(`Invalid env vars: ${invalid.join('; ')}`);

  if (env.isProduction && env.jwtSecret === 'dev-only-secret') {
    problems.push('JWT_SECRET must be set to a strong value in production');
  }

  // A SameSite=None cookie is silently dropped by every browser over plain
  // HTTP. Catching it here beats a production login that "succeeds" and then
  // 401s on the very next request.
  if (env.cookieSameSite === 'none' && !env.isProduction) {
    problems.push('COOKIE_SAMESITE=none requires HTTPS, so it only works with NODE_ENV=production');
  }

  if (env.isProduction && env.exposeErrorDetails) {
    problems.push('EXPOSE_ERROR_DETAILS must not be enabled in production');
  }

  // Fail at boot, not on the first image upload during service.
  if (env.storageDriver === 'bunny') {
    const required: [string, string][] = [
      ['BUNNY_STORAGE_ZONE', env.bunnyStorageZone],
      ['BUNNY_ACCESS_KEY', env.bunnyAccessKey],
      ['BUNNY_CDN_URL', env.bunnyCdnUrl],
      ['BUNNY_BASE_URL', env.bunnyBaseUrl],
    ];
    const blank = required.filter(([, value]) => value.trim() === '').map(([key]) => key);
    if (blank.length > 0) {
      problems.push(`STORAGE_DRIVER=bunny requires: ${blank.join(', ')}`);
    }
  }

  if (problems.length > 0) {
    throw new Error(`Environment configuration error.\n  - ${problems.join('\n  - ')}`);
  }
}

export default env;
