# ACD Cafe — Architecture & Design

Context for anyone picking this codebase up. The [README](README.md) covers how
to run it; this covers **why it is shaped the way it is**, so the next change
fits the grain instead of fighting it.

---

## 1. The problem being solved

A single café. Today:

- Orders are taken on paper, walked to the kitchen, and lost or misread.
- Guests on the veranda and lawn are out of eyeshot and cannot summon anyone.
- At the counter, the biller retypes the entire order into legacy POS software,
  **searching each item by name** — slow, and wrong under pressure.
- A table that orders again 15 minutes later becomes a second, disconnected
  ticket, so nobody has one view of what that table owes.

Four screens, one backend:

| Screen                | Device                            | Auth                                    |
| --------------------- | --------------------------------- | --------------------------------------- |
| Customer ordering     | guest's own phone, via a table QR | none — the QR token _is_ the credential |
| Waiter                | shared Android phone              | 4-digit PIN                             |
| Kitchen display (KDS) | one tablet                        | 4-digit PIN                             |
| Billing / admin       | counter PC browser tab            | 4-digit PIN                             |

---

## 2. Why this stack

| Decision                                              | Reason                                                                                                                                | What we rejected                                                            |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **Separate Express service** (not Next.js API routes) | Socket.IO needs a long-lived process holding open connections. Serverless functions cannot.                                           | Next.js full-stack                                                          |
| **Socket.IO**                                         | Four screens must react to each other within a second. Polling four screens against Mongo is worse in every way.                      | polling, SSE (need bidirectional)                                           |
| **MongoDB**                                           | An order round is a document with nested item lines. The schema will move as the café learns.                                         | Postgres — better for the money, worse for the iteration speed at this size |
| **TypeScript**                                        | Four clients share these shapes. A renamed status should break the build, not a shift.                                                | plain JS                                                                    |
| **No Redis (Phase 1)**                                | One café, one process. Redis solves multi-instance fan-out we do not have.                                                            | premature                                                                   |
| **Vitest**                                            | Runs TS ESM natively.                                                                                                                 | Jest — needs ts-jest/Babel and ESM workarounds for zero gain                |
| **Bunny.net for images**                              | The café already pays for a storage zone. Menu photos are served by a CDN instead of by the one VPS that is also running the kitchen. | S3 (another vendor, another bill), serving images off the app server        |

**One process, one instance.** Socket.IO rooms live in this process's memory. A
second worker means a kitchen tablet on worker B never hears an order placed
through worker A. Scaling out requires the Socket.IO Redis adapter — a Phase 2
decision, not a config tweak. `ecosystem.config.cjs` pins `instances: 1`.

---

## 3. Shape of the code

```
Request  →  route (auth + validate)  →  controller  →  service  →  model
                                             │            │
                                             │            ├→ audit log
                                             │            └→ socket broadcast
                                             ↓
                                      response envelope
```

| Layer          | Job                                                       | Must never                           |
| -------------- | --------------------------------------------------------- | ------------------------------------ |
| `routes/`      | Mount paths, attach auth/authorize/validate               | contain logic                        |
| `middlewares/` | Auth, validation, rate limits, logging, error translation | know about the café                  |
| `controllers/` | Parse the request, call one service, send an envelope     | contain business rules               |
| `services/`    | Every business rule                                       | touch `req`/`res`                    |
| `models/`      | Schema, indexes, invariants the DB can enforce            | contain workflow                     |
| `sockets/`     | Transport                                                 | decide _when_ something is broadcast |

**The rule that keeps this readable:** a service takes plain arguments plus an
`Actor` — never a `Request`. That makes it callable from a route, a seed script
or a future cron job, and it means the audit log always has an author, even when
the author is "the customer at M2".

Domain enums live in `config/constants.ts` as `as const` objects with a derived
union type. Add a status there and every `switch` that fails to handle it stops
compiling. That file is the contract the four frontends import too — socket
event names and room builders included, so nobody types `'round:new'` by hand.

---

## 4. The data model, and why

```
TableMaster ──< TableSession ──< OrderRound ──< items[]
                     │                              │
                     ├──< ServiceRequest            └─ status, price snapshot
                     └──< BillingExport ──< lineItems[]

ProductMaster    Counter    User    AuditLog
```

### TableSession — one continuous occupancy

From the first order until the bill is closed. **This is the fix for the add-on
problem**: round 2 attaches to the same session, so M2 has one bill, not three.

Closing flips `status`/`isActive`; it never deletes. A new guest at the same
table always gets a brand-new session document, so nothing carries over.

### OrderRound — append-only

One "Place Order" tap = one round. Rounds are never merged into each other.
Item lines snapshot `posName`, `unitPrice` and `taxPercent` **at order time**,
which is what makes a later menu price change leave history alone.

### Why item-level status, not just round-level

The kitchen genuinely finishes 2 teas before the sandwich, and the waiter should
be told about the teas now. So status lives on the item, and round/session
status are **derived** from it in `services/statusDerivation.ts` — a round is
only as far along as its least-progressed live item. One place, so the KDS, the
table grid and the customer's phone cannot disagree.

### Counter — atomic sequences

KOT ids and session numbers come from `findOneAndUpdate($inc)`, not `count()+1`,
which races. Two waiters ordering in the same second must not both get KOT 1051.

---

## 5. Invariants enforced by the database, not by `if`

Application-level checks lose races. These are indexes:

| Invariant                           | Mechanism                                                    |
| ----------------------------------- | ------------------------------------------------------------ |
| One live session per table          | unique partial index on `{ tableId }` where `isActive: true` |
| A replayed order does not duplicate | unique index on `{ sessionId, idempotencyKey }`              |
| Round numbers are dense per session | unique index on `{ sessionId, roundNumber }`                 |
| Product codes are unique            | unique index on `productCode`                                |
| Bill numbers never repeat           | unique index on `billNumber`                                 |

`TableSession.isActive` exists as a separate field _only_ because
`partialFilterExpression` cannot express `$ne: 'closed'`. A `pre('save')` hook
keeps it honest.

The test suite proves this: five simultaneous "open table" requests produce
exactly one session. That is why the tests run against a real MongoDB — a
mocked driver would prove nothing about an index.

---

## 6. Two views over the same data

The single most important design point, and the one most likely to be
"fixed" by mistake:

> **The KDS splits. Billing merges.**

Two teas ordered an hour apart are **two cooking jobs** — the kitchen must see
two cards, each with its own timer. The guest pays for **"4 Tea"** — one bill
line. Same rows in `OrderRound.items`, two projections. Do not make one match
the other.

---

## 7. Realtime contract

Rooms, not broadcasts:

| Room                                                           | Who                                |
| -------------------------------------------------------------- | ---------------------------------- |
| `role:kitchen` / `role:waiter` / `role:billing` / `role:admin` | staff screens                      |
| `table:<tableId>`                                              | customer phones at that table      |
| `session:<sessionId>`                                          | anyone following one running order |

Credentials go in the handshake: staff present the same JWT they use for REST,
customer phones present their table QR token. **A customer socket is pinned to
its table at handshake and cannot join another table's room**, even if it asks.

Menu availability is the one genuinely global event (`emitToAll`) — customer
phones sit in table rooms, so a staff-only broadcast would silently miss every
one of them. That was a real bug caught by the socket tests.

> **Sockets notify. REST tells the truth.**
> A kitchen tablet that dropped off the Wi-Fi re-fetches `GET /kitchen/queue` on
> reconnect rather than replaying missed events. Build every client that way.

---

## 8. Trust boundaries

| Caller   | Identified by               | Can reach                                      |
| -------- | --------------------------- | ---------------------------------------------- |
| Customer | random `qrToken` in the URL | their own table only                           |
| Waiter   | JWT (PIN login)             | table grid, ordering, service requests         |
| Kitchen  | JWT                         | KDS queue, item status, the 86 toggle          |
| Billing  | JWT                         | consolidation, export, closing sessions        |
| Admin    | JWT                         | everything, plus master data and the audit log |

`code` ("M2") and `qrToken` are **separate on purpose**. If the URL carried the
code, anyone could type `/order/M2` and order onto someone else's table. The
token is random and rotatable — reprint the sticker and the old one dies.

The client sends **product codes and quantities only**. Price, tax and POS name
are read server-side from `ProductMaster`, so a tampered request cannot order a
₹500 item for ₹5. There is a test for exactly this.

---

## 9. Failure handling

**Nothing is deleted.** Closing flips a flag. Cancelled items stay on the round,
excluded from the bill, retained in history. Every state change lands in
`AuditLog` with the actor — that is the answer to "the guest says they never
ordered that".

**Idempotency.** Every round carries a key, unique within its session. A
double-tapped button or a retry after dropped Wi-Fi returns the original round
with HTTP 200 instead of sending a second ticket. Scoped to the session, not
global — a global key would let two tables with naive client keys collide.

**Cancel-after-prep raises a hold.** Cancelling an item the kitchen already
cooked sets `heldForReview`; billing then cannot close without an explicit
`force`. A discrepancy goes to a manager rather than being silently absorbed.

**A failed POS hand-off never blocks a bill.** The export is recorded as
`failed` with a retry, and staff can still print and take payment. Blocking a
paying customer on integration uptime is never the right trade.

**Errors are translated in one place.** `middlewares/errorHandler.ts` turns
driver errors into the standard envelope. `details` on a validation failure is
always an **array** of `{ field, message, value }` — frontends index into it.

---

## 10. Where to change things

| To change…                           | Touch                                        | Nothing else moves because…                 |
| ------------------------------------ | -------------------------------------------- | ------------------------------------------- |
| POS integration (API / CSV / bridge) | `billing.service.ts` → `dispatch()`          | the bill is already computed and frozen     |
| Image storage (another CDN)          | add a `StorageDriver` in `services/storage/` | products store a URL + key, not a location  |
| Split the KDS by station             | filter in `getKitchenQueue`                  | `kitchenStation` is already on every item   |
| Split / partial bills                | `billing.service.ts`                         | `BillingExport` is already many-per-session |
| Add a role                           | `constants.ts` + `authorize()` on routes     | the seed asserts every role has a login     |
| Escalation timings                   | `.env`                                       | thresholds are config, not code             |

---

## 11. Deliberately not built

| Not built              | Why                                           | When                                                |
| ---------------------- | --------------------------------------------- | --------------------------------------------------- |
| Redis                  | one instance                                  | multiple app servers                                |
| Thermal printer bridge | the KDS is the ticket                         | if paper backup is wanted                           |
| Split / partial bills  | Phase 1 is one bill per session               | Phase 2 — schema already allows it                  |
| Multi-station KDS      | one shared display is enough                  | Phase 3 — it is a filter                            |
| Analytics              | needs real trading data first                 | Phase 3                                             |
| Refresh tokens         | a 12h token covers a shift                    | if shifts run longer                                |
| Mongo transactions     | needs a replica set; standalone mongod cannot | if a bill ever spans two writes that must be atomic |

---

## 12. Known gaps

Worth knowing before this runs a real café:

- **No automated backup.** Set up `mongodump` on a cron. The audit trail is
  worthless if the disk dies.
- **No image resizing.** A 3 MB phone photo is served as-is to a phone on café
  Wi-Fi. Add `sharp` to the upload path when the menu has real photos.
- **No per-request query timeout.** `serverSelectionTimeoutMS` covers a
  connection failure, not a slow query.
- **Bill numbers must never be rewound** in production. `seed:reset` does rewind
  them, which is why it refuses to run with `NODE_ENV=production`.
- **The seeded menu is placeholder data.** Import the real Product Master via
  `POST /products/bulk`, then run `GET /products/audit` to find duplicate codes
  and zero prices before go-live.
