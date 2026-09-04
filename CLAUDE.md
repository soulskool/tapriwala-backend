# ACD Cafe — Backend

Express 5 + TypeScript (ESM) + MongoDB + Socket.IO. Serves four frontends from
one process. The workspace-level [CLAUDE.md](../CLAUDE.md) covers both apps;
this is the backend-specific brief.

**Read [ARCHITECTURE.md](ARCHITECTURE.md) before changing anything structural.**
[README.md](README.md) covers running it, the env vars and the API surface.

---

## Commands

```bash
npm run dev          # tsx watch, :5010
npm run seed         # 20 tables, 10 products, 4 users — prints PINs and QR URLs
npm run seed:reset   # wipes everything first (refuses when NODE_ENV=production)
npm run check        # typecheck + lint + format + tests — run before committing
npm test             # Vitest, single-threaded, against MONGO_URI_TEST
npm run build        # tsc -p tsconfig.build.json
```

Current state: **212 tests passing, typecheck and lint clean.**

Tests need a database whose name ends in `_test`. The helper drops it on
teardown and refuses to run against anything else — that guard is the only thing
standing between a mistyped env var and the day's trading.

---

## Layers

```
route (auth + validate) → controller → service → model
                              │           ├→ audit log
                              │           └→ socket broadcast
                              ↓
                       response envelope
```

- Controllers parse the request, call **one** service, send an envelope. No
  business logic.
- Services hold every business rule and **never touch `req`/`res`** — they take
  plain arguments plus an `Actor`, so they are callable from a route, a script
  or a future cron job, and the audit log always has an author.
- Models own schema, indexes, and the invariants the database can enforce.
- `sockets/` is transport only; services decide _when_ something is broadcast.

`config/constants.ts` is the contract. Every domain enum is an `as const` object
with a derived union type, so adding a status breaks every `switch` that fails
to handle it. **The frontend mirrors this file** at
`../frontend/src/lib/constants.ts` — change one, change both.

---

## Invariants the database enforces, not `if` statements

Application-level checks lose races. These are indexes:

| Invariant                           | Mechanism                                                    |
| ----------------------------------- | ------------------------------------------------------------ |
| One live session per table          | unique partial index on `{ tableId }` where `isActive: true` |
| A replayed order does not duplicate | unique index on `{ sessionId, idempotencyKey }`              |
| Round numbers dense per session     | unique index on `{ sessionId, roundNumber }`                 |
| Product codes unique                | unique index on `productCode`                                |
| Bill numbers never repeat           | unique index on `billNumber`                                 |

KOT ids, session numbers and bill numbers come from `findOneAndUpdate($inc)`,
never `count() + 1`.

The integration tests fire five simultaneous "open table" requests and assert
exactly one session exists. That is why they run against a real MongoDB — a
mocked driver proves nothing about an index.

---

## Things that look like bugs and are not

- **`pending → ready` is legal.** A barista pouring a tea in twenty seconds taps
  Ready without ever tapping Accept. Forward skips are allowed; incoherent
  moves (un-readying to pending) are not.
- **`TableSession.isActive` duplicates `status`.** It exists only because
  `partialFilterExpression` cannot express `$ne: 'closed'`. A `pre('save')` hook
  keeps it honest.
- **A failed POS export returns 201, not an error.** Staff must still be able to
  print and take payment while the POS link is down. The failure is in the
  payload with a retry.
- **`emitToAll` for menu availability.** Customer phones sit in _table_ rooms,
  not role rooms, so a staff-only broadcast would silently miss every one of
  them. That was a real bug the socket tests caught.
- **A fresh service request has `needsAttention: false`.** Escalation is
  time-based by design — a new request is a badge, not an alarm.

---

## Storage

`STORAGE_DRIVER=bunny` in production, `local` in dev. Tests force the local
driver regardless (`getStorageDriver()` checks `env.isTest`), so the suite never
writes to the real CDN and needs no credentials.

Two Bunny hosts, not interchangeable: writes `PUT` to
`BUNNY_BASE_URL/<zone>/<key>` with an `AccessKey` header; guests read
`BUNNY_CDN_URL/<key>` with no credential. Get the region prefix wrong
(`storage.` vs `sg.storage.`) and every upload 401s.

A failed delete never fails the request — an orphaned image costs pennies, a
failed "replace image" mid-service costs a menu.

**Never print the contents of `.env`.** It holds the real JWT secret and the
Bunny access key. `.env.example` documents every variable without values.

---

## Gotchas

- **ESM**: relative imports need the `.js` extension, even from `.ts` files.
- **Mongoose's ESM shim has no `models` export.** Use `import mongoose from
'mongoose'` then `mongoose.models.X`.
- **Vitest, not Jest.** `maxWorkers: 1`, `fileParallelism: false` — the tests
  share one database.
- **express-rate-limit needs `ipKeyGenerator`** in custom key generators, or it
  throws on IPv6.
- **Validation `details` must stay an array** through the error handler. Do not
  spread it — an object breaks every frontend form.
- **One process only.** `ecosystem.config.cjs` pins `instances: 1` because
  Socket.IO rooms are in-process memory.
