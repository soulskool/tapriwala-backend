import type { ServiceRequestStatus, ServiceRequestType } from '../config/constants.js';
import * as serviceRequestService from '../services/serviceRequest.service.js';
import * as sessionService from '../services/session.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { sendCreated, sendPaginated, sendSuccess } from '../utils/ApiResponse.js';
import { getActor } from '../utils/actor.js';
import { getPagination } from '../utils/pagination.js';
import { queryBool, queryDate } from '../utils/helpers.js';

/** POST /service-requests — staff raise a request on a table's behalf. */
export const raise = asyncHandler(async (req, res) => {
  const { tableId, type, note } = req.body as {
    tableId: string;
    type: ServiceRequestType;
    note?: string;
  };

  const session = await sessionService.findActiveByTable(tableId);

  const { request, created } = await serviceRequestService.raise({
    tableId,
    sessionId: session ? String(session._id) : null,
    type,
    ...(note !== undefined ? { note } : {}),
    actor: getActor(req),
    ip: req.ip ?? null,
  });

  if (!created) {
    return sendSuccess(res, request, 'Existing request updated');
  }
  return sendCreated(res, request, 'Request raised');
});

/** GET /service-requests — filtered list for dashboards and history. */
export const list = asyncHandler(async (req, res) => {
  const { page, limit, skip } = getPagination(req);

  const { items, total } = await serviceRequestService.list(
    {
      status: req.query.status as ServiceRequestStatus | undefined,
      type: req.query.type as ServiceRequestType | undefined,
      tableId: req.query.tableId as string | undefined,
      sessionId: req.query.sessionId as string | undefined,
      openOnly: queryBool(req.query.openOnly),
      from: queryDate(req.query.from),
      to: queryDate(req.query.to),
    },
    skip,
    limit,
  );

  return sendPaginated(res, items, page, limit, total);
});

/**
 * GET /service-requests/queue — the waiter dashboard feed.
 * Oldest first, with `isEscalated` set once a request passes the threshold.
 */
export const queue = asyncHandler(async (_req, res) => {
  const requests = await serviceRequestService.getLiveQueue();
  return sendSuccess(res, {
    requests,
    count: requests.length,
    escalated: requests.filter((request) => request.isEscalated === true).length,
  });
});

/** PATCH /service-requests/:id — acknowledge / resolve / dismiss. */
export const update = asyncHandler(async (req, res) => {
  const { status, note } = req.body as { status: ServiceRequestStatus; note?: string };

  const request = await serviceRequestService.update({
    requestId: req.params.id as string,
    status,
    ...(note !== undefined ? { note } : {}),
    actor: getActor(req),
    ip: req.ip ?? null,
  });

  return sendSuccess(res, request, `Request ${request.status}`);
});
