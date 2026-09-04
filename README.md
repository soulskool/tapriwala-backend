# ACD Cafe — Backend (Phase 1)

Real-time ordering, KDS and billing backend for a single café.
Express 5 + TypeScript + MongoDB (Mongoose) + Socket.IO, in one process.

**New here? Read [ARCHITECTURE.md](ARCHITECTURE.md) first** — it explains why the
system is shaped this way, and which design decisions must not be "fixed".

---

## Quick start

```bash
npm install
cp .env.example .env        # then edit MONGO_URI and JWT_SECRET
npm run seed                # tables, sample menu, 4 staff logins, prints QR URLs
npm run dev                 # http://localhost:5010/api/v1
```

| Script                            | Does                                                                              |
| --------------------------------- | --------------------------------------------------------------------------------- |
| `npm run dev`                     | tsx watch, reloads on save                                                        |
| `npm run build`                   | emit to `dist/` (uses `tsconfig.build.json`, excludes tests)                      |
| `npm start`                       | run the built server                                                              |
| `npm run typecheck`               | `tsc --noEmit` over src **and** tests                                             |
| `npm run lint` / `lint:fix`       | ESLint 9, type-aware                                                              |
| `npm run format` / `format:check` | Prettier                                                                          |
| `npm test` / `test:watch`         | Vitest — 200 tests (unit + integration)                                           |
| **`npm run check`**               | **typecheck + lint + test — run this before every commit**                        |
| `npm run seed`                    | idempotent: creates anything missing, never rotates an already-printed QR         |
| `npm run seed:reset`              | wipes sessions/rounds/requests/bills/audit/counters first (refuses in production) |

Seeded logins (dev only — change these):

| Role    | Phone      | PIN  |
| ------- | ---------- | ---- |
| admin   | 9999999999 | 1234 |
| waiter  | 9000000001 | 1111 |
| kitchen | 9000000002 | 2222 |
| billing | 9000000003 | 3333 |

---

## Tests

```bash
npm test                                    # everything (200 tests, 15 files)
npx vitest run tests/unit                   # unit only — fast, no database
npx vitest run tests/integration/billing    # one area
npm run test:watch                          # while developing
```

Written with **Vitest**, not Jest — it runs TypeScript ESM natively, where Jest
needs ts-jest/Babel plus ESM workarounds for no gain. The API is the same
(`describe`/`it`/`expect`), so migrating is mechanical if you ever want to.

```
tests/
  helpers/            server boot, fixtures, scenario builders
  unit/               pure logic — no database, milliseconds
    money             rounding, line amounts, tax, cancelled-line exclusion
    statusDerivation  round/session status from item statuses
    helpers           query coercion, time, token generation
    apiError          error → status/code mapping, response envelopes
    billingCsv        CSV escaping (a comma in a POS name shifts every column)
    storage           image validation, path traversal, magic bytes
  integration/        real HTTP + real MongoDB, one file per area
    auth              login, role permissions, error envelope shape
    ordering          QR flow, idempotency, add-on rounds, tamper resistance
    kitchen           KDS tickets, item-level progress, transition rules
    products          86 toggle, price snapshots, bulk import, image upload
    sessions          concurrency, transfers, review hold, closing
    serviceRequests   dedupe, escalation, bill requests
    billing           consolidation, POS export, retry, close-out
    admin             overview, users, audit trail, table master
    sockets           handshake auth, broadcasts, table isolation
```

**Integration tests use a real MongoDB and stub nothing.** That is deliberate:
the guarantees worth testing here live in database indexes. "Five simultaneous
table opens create exactly one session" cannot be proven against a mocked
driver. Each file boots its own server on an ephemeral port and re-seeds, so
files are independent and readable on their own.

They use `MONGO_URI_TEST` and **drop that database on teardown**. The helper
refuses to run unless the database name ends in `_test`, so a mistyped env var
cannot erase the day's trading.

---

## Layout

```
src/
  config/       constants.ts (all enums + socket contract), env.ts (validated), db.ts
  types/        express.d.ts (req.user / req.customer), common.ts (DTOs)
  utils/        ApiError, ApiResponse, asyncHandler, logger (winston), jwt, actor, helpers, pagination
  middlewares/  errorHandler (global), validate, authMiddleware, requestLogger, rateLimiter
    validators/ one file per domain + barrel — imported as validate(placeOrderValidation)
  models/       Mongoose schemas + indexes
  services/     all business rules live here
  controllers/  thin: parse request -> call service -> send envelope
  routes/       auth / tables / products / sessions / rounds / kitchen / service-requests / billing / admin / public
  sockets/      server (rooms + handshake auth) and emitter (what services call)
  services/storage/  pluggable image storage (Bunny.net CDN in prod, local disk in dev)
  scripts/      seed.ts
```

**The rule that keeps it readable:** controllers never contain business logic and
services never touch `req`/`res`. A service takes plain arguments plus an
`Actor`, so it is callable from a route, a script or a future cron job.

### Response envelope

Every response is one of two shapes, so all four frontends share one fetch wrapper.

```jsonc
{ "success": true,  "message": "...", "data": { }, "meta": { "pagination": {} } }
{ "success": false, "error": { "code": "VALIDATION_ERROR", "message": "...", "details": [ { "field": "pin", "message": "PIN must be 4 digits" } ] }, "requestId": "..." }
```

`details` on a validation failure is always an **array** of `{ field, message, value }` —
index into it to mark inputs red. `requestId` is echoed on the `x-request-id`
header and appears in the logs, so a staff screenshot maps to a log line.

---

## Domain decisions worth knowing before you change anything

**Item status is the only truth.** Round status and session status are _derived_
from item statuses in `services/statusDerivation.ts` — a round is only as far
along as its least-progressed live item. Never store them as independent facts.

**Prices are snapshotted at order time.** `OrderRound.items` carries its own
`unitPrice`, `taxPercent` and `posName`. Editing a menu price never re-prices a
placed round. The client sends product codes and quantities only; price comes
from the server.

**One live session per table is enforced by MongoDB**, not by an `if`. A unique
partial index on `{ tableId }` where `isActive: true` means five simultaneous
"open table" taps produce exactly one session (verified in the test suite). That
is why `TableSession.isActive` exists as a separate field —
`partialFilterExpression` cannot express `$ne: 'closed'`.

**Ordering is idempotent.** Every round carries an `idempotencyKey`, unique
**within its session**. A double-tapped "Place Order", or a retry after the
phone dropped Wi-Fi, returns the original round with HTTP 200 instead of sending
a second ticket. The key is session-scoped on purpose: a global one would let
two tables whose clients generate naive keys ("1", "2") collide, and the second
table would silently be handed the first table's order.

**KDS splits, billing merges.** The kitchen sees two teas ordered an hour apart
as two separate cards (two cooking jobs). The bill merges them by `productCode`
into "4 Tea". Same data, two views — do not "fix" one to match the other.

**Nothing is deleted.** Closing a session flips `status`/`isActive`. Cancelled
items stay on the round, excluded from the bill and retained in history. Every
state change is written to `AuditLog` with the actor who did it.

**A cancellation after the kitchen finished the item** sets `heldForReview` on
the session; billing then cannot close it without an explicit `force`. That is
the manager-review path instead of silently absorbing the loss.

**Sockets notify, REST tells the truth.** A kitchen tablet that drops off the
Wi-Fi re-fetches `GET /kitchen/queue` on reconnect rather than replaying missed
events. Build every client that way.

---

## Realtime

Connect with credentials in the handshake — a staff JWT, or a table QR token:

```js
io('http://localhost:5010', { auth: { token } }); // staff
io('http://localhost:5010', { auth: { qrToken } }); // customer phone
```

Customers are pinned to their own table room at handshake and cannot join
another table's. Rooms: `role:<role>`, `table:<tableId>`, `session:<sessionId>`.

Server → client: `round:new`, `round:itemStatus`, `round:status`,
`session:statusChange`, `session:opened`, `session:closed`, `serviceRequest:new`,
`serviceRequest:update`, `product:availability`, `table:status`.
Names and room builders live in `config/constants.ts` (`SOCKET_EVENTS`,
`SOCKET_ROOMS`) — import them rather than typing strings on the client.

---

## API

Base path `/api/v1`. All staff routes need `Authorization: Bearer <token>` or the
auth cookie. Public routes need no login at all.

### Customer (tokenless — the QR token in the URL _is_ the credential)

```
GET   /public/tables/:qrToken                   landing: table, live session, warnings
GET   /public/tables/:qrToken/menu              available items only, grouped
GET   /public/tables/:qrToken/order-status      live status of this table's rounds
POST  /public/tables/:qrToken/orders            place a round (opens the session on first order)
POST  /public/tables/:qrToken/service-requests  water | call_staff | bill
```

### Auth

```
POST  /auth/login          { phone, pin }
POST  /auth/logout
GET   /auth/me
```

### Tables

```
GET   /tables                    live table grid  (any staff)
GET   /tables/master             plain list
GET   /tables/qr-sheet           every QR URL, for printing        (admin)
GET   /tables/:id
POST  /tables                    (admin)
PATCH /tables/:id                (admin)
POST  /tables/:id/rotate-qr      invalidates the printed sticker   (admin)
```

### Products

```
GET   /products                  ?category= &station= &search= &availableOnly= &includeInactive=
GET   /products/menu             grouped by category
GET   /products/categories
GET   /products/audit            duplicate codes/names, zero prices  (admin)
GET   /products/:id
PATCH /products/:id/availability the 86 toggle        (kitchen/billing/admin)
POST  /products                  (admin)
POST  /products/bulk             Excel import upsert  (admin)
PATCH /products/:id              (admin)
POST  /products/:id/image        multipart, field "image"  (admin)
DELETE /products/:id/image       (admin)
```

### Sessions & ordering

```
GET   /sessions                  ?status= &tableId= &activeOnly= &from= &to=
GET   /sessions/:id              full detail: rounds, items, requests, totals
GET   /sessions/:id/rounds
POST  /sessions                  open a table            (waiter/billing)
POST  /sessions/:id/rounds       place an order round    (waiter/billing)
POST  /sessions/:id/close        (billing)  — body: { force?, note?, billingExportId? }
POST  /sessions/:id/transfer     (billing)  — body: { toTableId, reason }
PATCH /sessions/:id/review       (billing)  — hold/release for manager review
```

### Kitchen

```
GET   /kitchen/queue             ?station= &includeServed= &sinceMinutes=
GET   /kitchen/ready             rounds sitting ready too long
GET   /rounds/:roundId
PATCH /rounds/:roundId/items/:itemId   { status, reason? }
PATCH /rounds/:roundId/status          apply one status to the whole ticket
```

### Service requests

```
GET   /service-requests/queue    waiter dashboard feed, oldest first
GET   /service-requests          filtered history
POST  /service-requests          staff raise on a table's behalf
PATCH /service-requests/:id      acknowledge | resolve | cancel
```

### Billing (billing/admin only)

```
GET   /billing/queue
GET   /billing/:sessionId/consolidate   the counter screen (read-only)
GET   /billing/:sessionId/csv           download as CSV
POST  /billing/:sessionId/export        freeze the bill and hand it to the POS
GET   /billing/exports  ·  GET /billing/exports/:id
PATCH /billing/exports/:id              record the POS invoice number / outcome
POST  /billing/exports/:id/retry
```

### Admin

```
GET   /admin/overview            whole floor in one read-only payload
GET   /admin/audit               the scrutiny trail
GET   /admin/users  ·  POST /admin/users  ·  PATCH /admin/users/:id
```

---

## POS integration (§6 of the master plan)

`services/billing.service.ts` → `dispatch()` is the **only** function that needs
to change when the vendor's capability is confirmed:

- `manual_display` — **Phase 1 default.** The screen is the integration: exact
  product codes and quantities, so the counter types instead of searching by name.
- `csv` — implemented (`toCsv`), ready if the POS supports import.
- `api` — deliberately returns `failed` with a clear message until a real
  endpoint exists. It fails loudly rather than pretending a bill was delivered.

A failed hand-off never blocks the bill: the export is recorded as `failed` with
a retry button, and staff can still print and take payment.

---

## Environment

See `.env.example`. `JWT_SECRET` and `MONGO_URI` are required; the server refuses
to start in production with the development secret. Notable knobs:

| Var                                  | Meaning                                                                                                                                                                                                                          |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CORS_ORIGINS`                       | comma-separated; also applied to Socket.IO                                                                                                                                                                                       |
| `COOKIE_SAMESITE`                    | `lax` (default) when the browser app and this API share a registrable domain — `localhost:3000` -> `localhost:5010` counts, since SameSite ignores the port. Use `none` only for genuinely different domains; it requires HTTPS. |
| `COOKIE_DOMAIN`                      | Set to share the session cookie across subdomains, e.g. `.cafe.com`                                                                                                                                                              |
| `CUSTOMER_BASE_URL`                  | QR codes encode `<this>/order/<qrToken>`                                                                                                                                                                                         |
| `SERVICE_REQUEST_ESCALATION_MINUTES` | when a waiting request turns red                                                                                                                                                                                                 |
| `SESSION_NUMBER_RESET`               | `daily` (default) or `never`                                                                                                                                                                                                     |
| `DEFAULT_TAX_PERCENT`                | fallback when a product has none                                                                                                                                                                                                 |

---

## Menu images

```bash
curl -X POST http://localhost:5010/api/v1/products/<id>/image   -H "Authorization: Bearer <admin token>"   -F "image=@sandwich.jpg"
```

Returns the absolute `imageUrl`, which then appears on the customer menu.
JPEG / PNG / WebP / AVIF, 3 MB max.

Validation is by declared MIME **and** magic bytes — a browser will happily send
`image/png` for a renamed executable, and whatever lands in storage is served
back verbatim. Stored filenames are random, so a user-supplied name never
becomes a path and two "coffee.jpg" uploads cannot collide.

### Two drivers

| `STORAGE_DRIVER` | Writes to                    | Read from                        | Use                                             |
| ---------------- | ---------------------------- | -------------------------------- | ----------------------------------------------- |
| `local`          | `uploads/` on disk           | `/uploads` served by Express     | dev, and the fallback if Bunny is down for good |
| `bunny`          | Bunny.net Storage over HTTPS | the Bunny CDN, never this server | production                                      |

**Bunny is the production driver.** It needs five variables:

```dotenv
STORAGE_DRIVER=bunny
BUNNY_BASE_URL=https://sg.storage.bunnycdn.com   # region storage host — WRITES
BUNNY_CDN_URL=https://<pull-zone>.b-cdn.net      # pull zone      — PUBLIC READS
BUNNY_STORAGE_ZONE=<zone name>
BUNNY_ACCESS_KEY=<zone password>                 # secret, never committed
BUNNY_FOLDER=acd-retreat                         # prefix inside a shared zone
```

Two hosts, and they are not interchangeable: uploads `PUT` to
`BUNNY_BASE_URL/<zone>/<key>` with an `AccessKey` header; customers read
`BUNNY_CDN_URL/<key>` with no credential at all. Get the region prefix wrong
(`storage.` vs `sg.storage.`) and every upload 401s. `assertEnv()` refuses to
boot with `bunny` selected and any of these blank, rather than failing on the
first admin who tries to add a photo.

`BUNNY_FOLDER` matters because the storage zone is shared with another project —
every key is written as `<BUNNY_FOLDER>/products/<32-hex>.<ext>`, and both the
folder and the upload's own name are sanitised so nothing can climb out of that
prefix.

Bunny is a network hop on an admin-facing path, so: 15 s timeout, an unreachable
CDN surfaces as **503 `INTEGRATION_ERROR`** ("try again in a moment") rather than
a 500, and a **failed delete never fails the request** — an orphaned image costs
pennies, a failed "replace image" mid-service costs a menu.

Tests always use the local driver (`getStorageDriver()` forces it when
`NODE_ENV=test`), so running the suite never writes to the real CDN and needs no
credentials. `tests/unit/bunnyStorage.test.ts` pins the request shape against a
mocked `fetch` instead.

To add a third backend later, implement `StorageDriver` (`save` + `remove`) in
`src/services/storage/`, register it in the factory, and extend the env union.
Products store a URL and an opaque `imageKey`, so nothing else in the app knows
where the bytes live.

Not done yet: **resizing**. A 3 MB phone photo is served as-is. Add `sharp` to
the upload path when the menu carries real photos.

---

## Deployment (single VPS)

```bash
npm ci
npm run build
pm2 start ecosystem.config.cjs && pm2 save && pm2 startup
```

`ecosystem.config.cjs` runs **one** instance on purpose. Socket.IO rooms live in
this process's memory, so a second worker would mean a kitchen tablet connected
to worker B never hears an order placed through worker A. Going multi-instance
requires the Socket.IO Redis adapter — a Phase 2 decision, not a config tweak.

Put nginx or Caddy in front for TLS. `trust proxy` is already set in production
so client IPs stay correct for rate limiting and the audit log.

---

## Not in Phase 1 (by design)

Redis (only needed past one server instance), thermal printer bridge, split /
partial bills (`BillingExport` is already many-per-session so this needs no
migration), multi-station KDS split (`kitchenStation` is already on every item —
it becomes a filter, not a data change), analytics.

## Known gaps, honestly

Worth knowing before this runs a real café:

- **No automated backup.** Set up `mongodump` on a cron before go-live; the
  audit trail is worthless if the disk dies.
- **No refresh tokens.** A staff token lasts `JWT_EXPIRES_IN` (12h) and then the
  device re-enters its PIN. Fine for a shift; revisit if shifts run longer.
- **No request timeout.** A pathological Mongo query could hold a connection
  open. `serverSelectionTimeoutMS` covers connection failure, not slow queries.
- **Bill numbers never reset.** They are a financial sequence. Never rewind the
  `bill_number` counter in production — `seed:reset` does, which is why it
  refuses to run with `NODE_ENV=production`.
- **The seeded menu is placeholder data.** Replace it via `POST /products/bulk`
  with the real Product Master, then run `GET /products/audit` to find duplicate
  codes and zero prices before go-live.
