import mongoose from 'mongoose';

import { AUDIT_ACTION, AUDIT_ENTITY } from '../config/constants.js';
import { connectDB, disconnectDB } from '../config/db.js';
import { assertEnv } from '../config/env.js';
import { User } from '../models/index.js';
import * as auditService from '../services/audit.service.js';
import { SYSTEM_ACTOR } from '../utils/actor.js';
import { logger } from '../utils/logger.js';

/**
 * Reactivates every deactivated staff account.
 *
 *   npm run users:activate
 *
 * The way back in when the only admin who could open Staff has been switched
 * off. Touches `isActive` and nothing else — PINs, roles and phones stay as
 * they are — and audits each account it flips, as `system`.
 */

async function main(): Promise<void> {
  assertEnv();
  await connectDB();

  const inactive = await User.find({ isActive: false }).select('name phone role isActive');
  if (inactive.length === 0) {
    logger.info('Every account is already active');
  }

  for (const user of inactive) {
    user.isActive = true;
    await user.save();
    await auditService.record({
      entityType: AUDIT_ENTITY.USER,
      entityId: user._id,
      action: AUDIT_ACTION.USER_UPDATED,
      actor: SYSTEM_ACTOR,
      before: { name: user.name, isActive: false },
      after: { name: user.name, isActive: true },
      meta: { script: 'users:activate' },
    });
    logger.info(`Activated ${user.name} (${user.role}, ${user.phone})`);
  }

  await disconnectDB();
  await mongoose.disconnect();
}

main().catch((error: Error) => {
  logger.error(`Activation failed: ${error.message}`, { stack: error.stack });
  process.exit(1);
});
