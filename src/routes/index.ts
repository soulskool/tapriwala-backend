import { Router } from 'express';
import mongoose from 'mongoose';

import { APP_CONSTANTS } from '../config/constants.js';
import { sendSuccess } from '../utils/ApiResponse.js';
import adminRoutes from './admin.routes.js';
import authRoutes from './auth.routes.js';
import billingRoutes from './billing.routes.js';
import kitchenRoutes from './kitchen.routes.js';
import orderRoutes from './order.routes.js';
import productRoutes from './product.routes.js';
import publicRoutes from './public.routes.js';
import serviceRequestRoutes from './serviceRequest.routes.js';
import sessionRoutes from './session.routes.js';
import tableRoutes from './table.routes.js';

/**
 * API v1 router.
 *
 * Grouped by the screen that consumes it:
 *   /public            → customer QR pages (no login)
 *   /tables            → live table grid + table master
 *   /sessions,/rounds  → ordering
 *   /kitchen           → KDS
 *   /service-requests  → waiter dashboard
 *   /billing           → counter
 *   /admin             → ops visibility, users, audit
 */
const router = Router();

router.get('/health', (_req, res) => {
  const states = ['disconnected', 'connected', 'connecting', 'disconnecting'];
  return sendSuccess(res, {
    status: 'ok',
    version: APP_CONSTANTS.API_VERSION,
    uptimeSeconds: Math.floor(process.uptime()),
    database: states[mongoose.connection.readyState] ?? 'unknown',
    timestamp: new Date(),
  });
});

router.use('/public', publicRoutes);
router.use('/auth', authRoutes);
router.use('/tables', tableRoutes);
router.use('/products', productRoutes);
router.use('/sessions', sessionRoutes);
router.use('/rounds', orderRoutes);
router.use('/kitchen', kitchenRoutes);
router.use('/service-requests', serviceRequestRoutes);
router.use('/billing', billingRoutes);
router.use('/admin', adminRoutes);

export default router;
