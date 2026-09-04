import jwt, { type SignOptions } from 'jsonwebtoken';

import { env } from '../config/env.js';
import type { Role } from '../config/constants.js';
import { ApiError } from './ApiError.js';

/** Claims embedded in a staff token. Kept tiny — the DB stays the source of truth. */
export interface JwtPayload {
  sub: string;
  role: Role;
  name: string;
}

export function signToken(payload: JwtPayload): string {
  const options: SignOptions = { expiresIn: env.jwtExpiresIn as SignOptions['expiresIn'] };
  return jwt.sign(payload, env.jwtSecret, options);
}

export function verifyToken(token: string): JwtPayload {
  try {
    const decoded = jwt.verify(token, env.jwtSecret);
    if (typeof decoded === 'string') {
      throw ApiError.unauthorized('Malformed token');
    }
    return decoded as unknown as JwtPayload;
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw ApiError.unauthorized('Session expired, please log in again');
    }
    if (error instanceof jwt.JsonWebTokenError) {
      throw ApiError.unauthorized('Invalid token');
    }
    throw error;
  }
}

export default { signToken, verifyToken };
