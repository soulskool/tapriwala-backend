import type { Role } from '../config/constants.js';

/**
 * Request augmentation.
 *
 * `user`     — set by `authenticate` for staff (waiter/kitchen/billing/admin).
 * `customer` — set by `resolveTableCode` for tokenless customer QR requests.
 * `requestId`— set by `requestLogger`, echoed on every error envelope.
 */
declare global {
  namespace Express {
    interface AuthenticatedUser {
      id: string;
      role: Role;
      name: string;
    }

    interface CustomerContext {
      tableId: string;
      tableCode: string;
      sessionId: string | null;
    }

    interface Request {
      user?: AuthenticatedUser;
      customer?: CustomerContext;
      requestId?: string;
    }
  }
}

export {};
