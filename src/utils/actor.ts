import type { Request } from 'express';
import { Types } from 'mongoose';

import { CUSTOMER_ACTOR, type Role } from '../config/constants.js';

/** Who performed an action — a staff member, or an anonymous QR customer. */
export interface Actor {
  role: Role | typeof CUSTOMER_ACTOR;
  userId: Types.ObjectId | null;
  name: string;
}

/**
 * Normalises the two authentication paths into one actor shape.
 *
 * Every state-changing service takes an Actor rather than a Request, so the
 * business layer stays testable and the audit log always has an author — even
 * when the author is "the customer at M2".
 */
export function getActor(req: Request): Actor {
  if (req.user) {
    return {
      role: req.user.role,
      userId: new Types.ObjectId(req.user.id),
      name: req.user.name,
    };
  }

  if (req.customer) {
    return {
      role: CUSTOMER_ACTOR,
      userId: null,
      name: `Customer @ ${req.customer.tableCode}`,
    };
  }

  return { role: CUSTOMER_ACTOR, userId: null, name: 'Unknown' };
}

/** Plain-object form stored on documents (`placedBy`, `openedBy`, ...). */
export function actorSnapshot(actor: Actor): {
  role: string;
  userId: Types.ObjectId | null;
  name: string;
} {
  return { role: actor.role, userId: actor.userId, name: actor.name };
}

/** Actor used by seed scripts and system-initiated changes. */
export const SYSTEM_ACTOR: Actor = {
  role: 'admin',
  userId: null,
  name: 'system',
};
