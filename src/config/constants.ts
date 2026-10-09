/**
 * Application-wide constants, domain enums and socket contracts.
 *
 * Everything here is declared `as const` and exported alongside a derived union
 * type, so the compiler keeps controllers, models and validators in sync: add a
 * status here and every consumer that does not handle it fails to build.
 */

// ─── HTTP / errors ───────────────────────────────────────────────────────────

export const HTTP_STATUS = {
  OK: 200,
  CREATED: 201,
  NO_CONTENT: 204,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNPROCESSABLE_ENTITY: 422,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
} as const;

export type HttpStatus = (typeof HTTP_STATUS)[keyof typeof HTTP_STATUS];

export const ERROR_CODES = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  CONFLICT: 'CONFLICT',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',
  DATABASE_ERROR: 'DATABASE_ERROR',
  INTEGRATION_ERROR: 'INTEGRATION_ERROR',
  INVALID_STATE: 'INVALID_STATE',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

// ─── App ─────────────────────────────────────────────────────────────────────

export const APP_CONSTANTS = {
  API_VERSION: 'v1',
  SERVICE_NAME: 'acd-cafe-api',

  DEFAULT_PAGE: 1,
  DEFAULT_PAGE_SIZE: 20,
  MAX_PAGE_SIZE: 100,

  /** Max items allowed in a single order round (guards against runaway carts). */
  MAX_ITEMS_PER_ROUND: 50,
  MAX_QUANTITY_PER_ITEM: 99,
  MAX_SPECIAL_INSTRUCTIONS_LENGTH: 300,

  /** Byte length of the random table QR token. */

  PIN_LENGTH: 4,
  BCRYPT_ROUNDS: 10,
} as const;

// ─── Roles ───────────────────────────────────────────────────────────────────

export const ROLES = {
  WAITER: 'waiter',
  KITCHEN: 'kitchen',
  BILLING: 'billing',
  ADMIN: 'admin',
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];
export const ROLE_VALUES = Object.values(ROLES) as Role[];

/** Pseudo-actor used when an action originates from a tokenless customer QR session. */
export const CUSTOMER_ACTOR = 'customer' as const;

// ─── Tables ──────────────────────────────────────────────────────────────────

export const TABLE_ZONES = {
  LEFT: 'Left',
  MIDDLE: 'Middle',
  RIGHT: 'Right',
  VERANDA: 'Veranda',
  LAWN: 'Lawn',
} as const;

export type TableZone = (typeof TABLE_ZONES)[keyof typeof TABLE_ZONES];
export const TABLE_ZONE_VALUES = Object.values(TABLE_ZONES) as TableZone[];

// ─── Kitchen stations ────────────────────────────────────────────────────────

export const KITCHEN_STATIONS = {
  KITCHEN: 'Kitchen',
  BEVERAGE: 'Beverage',
  OTHER: 'Other',
} as const;

export type KitchenStation = (typeof KITCHEN_STATIONS)[keyof typeof KITCHEN_STATIONS];
export const KITCHEN_STATION_VALUES = Object.values(KITCHEN_STATIONS) as KitchenStation[];

// ─── Sessions ────────────────────────────────────────────────────────────────

export const SESSION_STATUS = {
  OCCUPIED: 'occupied',
  ORDER_PENDING: 'order_pending',
  PREPARING: 'preparing',
  READY: 'ready',
  BILL_REQUESTED: 'bill_requested',
  CLOSED: 'closed',
} as const;

export type SessionStatus = (typeof SESSION_STATUS)[keyof typeof SESSION_STATUS];
export const SESSION_STATUS_VALUES = Object.values(SESSION_STATUS) as SessionStatus[];

// ─── Orders ──────────────────────────────────────────────────────────────────

export const ORDER_SOURCE = {
  CUSTOMER_QR: 'customer_qr',
  WAITER: 'waiter',
} as const;

export type OrderSource = (typeof ORDER_SOURCE)[keyof typeof ORDER_SOURCE];
export const ORDER_SOURCE_VALUES = Object.values(ORDER_SOURCE) as OrderSource[];

/**
 * Whether a round is eaten at the table or carried out.
 *
 * Lives on the round, not the session: one occupancy genuinely mixes the two —
 * a table drinking chai orders samosas to take home — and the round is already
 * the unit the KOT and the KDS card are built from, so "this ticket is a
 * parcel" is a fact the ticket carries rather than one looked up elsewhere.
 *
 * `dining` is the default everywhere, and the only value a customer QR order
 * can ever have: the public controller does not read this field off the
 * request, so a guest cannot mark their own order a parcel. Staff choose it on
 * the table screen.
 */
export const ORDER_TYPE = {
  DINING: 'dining',
  PARCEL: 'parcel',
} as const;

export type OrderType = (typeof ORDER_TYPE)[keyof typeof ORDER_TYPE];
export const ORDER_TYPE_VALUES = Object.values(ORDER_TYPE) as OrderType[];

/** What the KOT and the bill print as a heading. */
export const ORDER_TYPE_LABEL: Record<OrderType, string> = {
  [ORDER_TYPE.DINING]: 'DINING',
  [ORDER_TYPE.PARCEL]: 'PARCEL',
};

export const ITEM_STATUS = {
  PENDING: 'pending',
  ACCEPTED: 'accepted',
  PREPARING: 'preparing',
  READY: 'ready',
  SERVED: 'served',
  CANCELLED: 'cancelled',
} as const;

export type ItemStatus = (typeof ITEM_STATUS)[keyof typeof ITEM_STATUS];
export const ITEM_STATUS_VALUES = Object.values(ITEM_STATUS) as ItemStatus[];

/**
 * Progress rank used to derive a round status from its items: a round is only
 * as far along as its least-progressed live item. `cancelled` is deliberately
 * excluded — cancelled items never hold a round back.
 */
export const ITEM_STATUS_RANK: Record<Exclude<ItemStatus, 'cancelled'>, number> = {
  [ITEM_STATUS.PENDING]: 0,
  [ITEM_STATUS.ACCEPTED]: 1,
  [ITEM_STATUS.PREPARING]: 2,
  [ITEM_STATUS.READY]: 3,
  [ITEM_STATUS.SERVED]: 4,
};

/**
 * Legal item status transitions.
 *
 * Forward skips are allowed — a barista pouring a tea in twenty seconds taps
 * Ready without ever tapping Accept, and the system should not argue. Backward
 * moves (ready -> preparing) are allowed for mistake recovery. What is blocked
 * is anything incoherent, like un-readying an item back to pending. Every
 * transition, forward or back, lands in the audit log.
 */
export const ITEM_STATUS_TRANSITIONS: Record<ItemStatus, ItemStatus[]> = {
  [ITEM_STATUS.PENDING]: [
    ITEM_STATUS.ACCEPTED,
    ITEM_STATUS.PREPARING,
    ITEM_STATUS.READY,
    ITEM_STATUS.CANCELLED,
  ],
  [ITEM_STATUS.ACCEPTED]: [
    ITEM_STATUS.PREPARING,
    ITEM_STATUS.READY,
    ITEM_STATUS.PENDING,
    ITEM_STATUS.CANCELLED,
  ],
  [ITEM_STATUS.PREPARING]: [ITEM_STATUS.READY, ITEM_STATUS.ACCEPTED, ITEM_STATUS.CANCELLED],
  [ITEM_STATUS.READY]: [ITEM_STATUS.SERVED, ITEM_STATUS.PREPARING, ITEM_STATUS.CANCELLED],
  [ITEM_STATUS.SERVED]: [ITEM_STATUS.READY],
  [ITEM_STATUS.CANCELLED]: [],
};

/** Item statuses the kitchen display is allowed to set. */
export const KITCHEN_SETTABLE_STATUSES: ItemStatus[] = [
  ITEM_STATUS.ACCEPTED,
  ITEM_STATUS.PREPARING,
  ITEM_STATUS.READY,
];

export const ROUND_STATUS = {
  PENDING: 'pending',
  ACCEPTED: 'accepted',
  PREPARING: 'preparing',
  READY: 'ready',
  SERVED: 'served',
  CANCELLED: 'cancelled',
} as const;

export type RoundStatus = (typeof ROUND_STATUS)[keyof typeof ROUND_STATUS];
export const ROUND_STATUS_VALUES = Object.values(ROUND_STATUS) as RoundStatus[];

// ─── Service requests ────────────────────────────────────────────────────────

export const SERVICE_REQUEST_TYPE = {
  WATER: 'water',
  CALL_STAFF: 'call_staff',
  BILL: 'bill',
} as const;

export type ServiceRequestType = (typeof SERVICE_REQUEST_TYPE)[keyof typeof SERVICE_REQUEST_TYPE];
export const SERVICE_REQUEST_TYPE_VALUES = Object.values(
  SERVICE_REQUEST_TYPE,
) as ServiceRequestType[];

export const SERVICE_REQUEST_STATUS = {
  OPEN: 'open',
  ACKNOWLEDGED: 'acknowledged',
  RESOLVED: 'resolved',
  CANCELLED: 'cancelled',
} as const;

export type ServiceRequestStatus =
  (typeof SERVICE_REQUEST_STATUS)[keyof typeof SERVICE_REQUEST_STATUS];
export const SERVICE_REQUEST_STATUS_VALUES = Object.values(
  SERVICE_REQUEST_STATUS,
) as ServiceRequestStatus[];

/** A request in one of these states is still live and must be de-duplicated. */
export const ACTIVE_SERVICE_REQUEST_STATUSES: ServiceRequestStatus[] = [
  SERVICE_REQUEST_STATUS.OPEN,
  SERVICE_REQUEST_STATUS.ACKNOWLEDGED,
];

// ─── Billing / POS export ────────────────────────────────────────────────────

export const EXPORT_METHOD = {
  API: 'api',
  CSV: 'csv',
  MANUAL_DISPLAY: 'manual_display',
} as const;

export type ExportMethod = (typeof EXPORT_METHOD)[keyof typeof EXPORT_METHOD];
export const EXPORT_METHOD_VALUES = Object.values(EXPORT_METHOD) as ExportMethod[];

export const EXPORT_STATUS = {
  PENDING: 'pending',
  SENT: 'sent',
  CONFIRMED: 'confirmed',
  FAILED: 'failed',
} as const;

export type ExportStatus = (typeof EXPORT_STATUS)[keyof typeof EXPORT_STATUS];
export const EXPORT_STATUS_VALUES = Object.values(EXPORT_STATUS) as ExportStatus[];

// ─── Counters (atomic sequences) ─────────────────────────────────────────────

export const COUNTER_KEYS = {
  SESSION_NUMBER: 'session_number',
  KOT_ID: 'kot_id',
  BILL_NUMBER: 'bill_number',
} as const;

export type CounterKey = (typeof COUNTER_KEYS)[keyof typeof COUNTER_KEYS];

/** KOT ids start above this so they never collide with legacy paper pads. */
export const KOT_SEQUENCE_START = 1000;

// ─── Audit log ───────────────────────────────────────────────────────────────

export const AUDIT_ENTITY = {
  SESSION: 'TableSession',
  ROUND: 'OrderRound',
  PRODUCT: 'ProductMaster',
  TABLE: 'TableMaster',
  SERVICE_REQUEST: 'ServiceRequest',
  BILLING_EXPORT: 'BillingExport',
  USER: 'User',
} as const;

export type AuditEntity = (typeof AUDIT_ENTITY)[keyof typeof AUDIT_ENTITY];

export const AUDIT_ACTION = {
  SESSION_OPENED: 'session.opened',
  SESSION_CLOSED: 'session.closed',
  SESSION_STATUS_CHANGED: 'session.status_changed',
  SESSION_TRANSFERRED: 'session.transferred',
  SESSION_HELD_FOR_REVIEW: 'session.held_for_review',

  ROUND_PLACED: 'round.placed',
  ROUND_ITEM_STATUS_CHANGED: 'round.item_status_changed',
  ROUND_ITEM_CANCELLED: 'round.item_cancelled',

  PRODUCT_CREATED: 'product.created',
  PRODUCT_UPDATED: 'product.updated',
  PRODUCT_AVAILABILITY_TOGGLED: 'product.availability_toggled',

  TABLE_CREATED: 'table.created',
  TABLE_UPDATED: 'table.updated',
  TABLE_QR_ROTATED: 'table.qr_rotated',

  SERVICE_REQUEST_RAISED: 'service_request.raised',
  SERVICE_REQUEST_UPDATED: 'service_request.updated',

  BILL_EXPORTED: 'billing.exported',
  BILL_EXPORT_RETRIED: 'billing.export_retried',
  BILL_EXPORT_CONFIRMED: 'billing.export_confirmed',

  USER_CREATED: 'user.created',
  USER_UPDATED: 'user.updated',
  USER_LOGIN: 'user.login',
} as const;

export type AuditAction = (typeof AUDIT_ACTION)[keyof typeof AUDIT_ACTION];

// ─── Socket.IO contract ──────────────────────────────────────────────────────

export const SOCKET_EVENTS = {
  // client -> server
  JOIN_ROLE: 'join:role',
  JOIN_TABLE: 'join:table',
  JOIN_SESSION: 'join:session',
  LEAVE_SESSION: 'leave:session',

  // server -> client
  ROUND_NEW: 'round:new',
  ROUND_ITEM_STATUS: 'round:itemStatus',
  ROUND_STATUS: 'round:status',
  SESSION_STATUS_CHANGE: 'session:statusChange',
  SESSION_OPENED: 'session:opened',
  SESSION_CLOSED: 'session:closed',
  SERVICE_REQUEST_NEW: 'serviceRequest:new',
  SERVICE_REQUEST_UPDATE: 'serviceRequest:update',
  PRODUCT_AVAILABILITY: 'product:availability',
  TABLE_STATUS: 'table:status',

  // transport level
  ERROR: 'app:error',
  JOINED: 'app:joined',
} as const;

export type SocketEvent = (typeof SOCKET_EVENTS)[keyof typeof SOCKET_EVENTS];

/** Room name builders — single source of truth for both server and client. */
export const SOCKET_ROOMS = {
  role: (role: Role): string => `role:${role}`,
  table: (tableId: string): string => `table:${tableId}`,
  session: (sessionId: string): string => `session:${sessionId}`,
} as const;

/** Staff rooms that receive "something changed on the floor" traffic. */
export const STAFF_ROLE_ROOMS: Role[] = [ROLES.WAITER, ROLES.KITCHEN, ROLES.BILLING, ROLES.ADMIN];

/**
 * The café's day, for "sales on 8 October".
 *
 * Stated outright rather than read from the server clock: the VPS runs on UTC,
 * where an IST day starts at 18:30 the evening before, so a 9pm bill would be
 * booked to tomorrow. India keeps no daylight saving, so the fixed offset and
 * the zone name can never disagree — the offset bounds the query, the name
 * labels each bill's day inside MongoDB.
 */
export const BUSINESS_TIMEZONE = 'Asia/Kolkata';
export const BUSINESS_UTC_OFFSET = '+05:30';
