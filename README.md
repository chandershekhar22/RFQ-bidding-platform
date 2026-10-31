# RFQ British Auction

A simplified RFQ (Request for Quotation) system with British Auction–style bidding.
It covers automatic bid-time extensions, a hard forced close time, configurable
trigger rules, and live visibility of auction progress.

## Deliverables

| Deliverable | Where |
|---|---|
| HLD with architecture diagram | [docs/HLD.md](docs/HLD.md) (architecture, ER and bid-flow diagrams, engine rules, scaling notes) |
| Schema design | [docs/schema.sql](docs/schema.sql) (diagram in the HLD, section 3) |
| Backend code | [backend/](backend/): Node.js, Express, PostgreSQL (Supabase) |
| Frontend code | [frontend/](frontend/): React, Vite, Tailwind |

## Stack

- **Backend:** Node.js 20+ (JavaScript, ES modules), Express, and `pg` against PostgreSQL hosted on Supabase.
- **Frontend:** React 18, Vite, Tailwind CSS v4, and React Router.
- **Tests:** Vitest. The engine unit tests need no database; the integration tests use a separate Postgres schema.

## Project structure

```
backend/
  src/engine/          Pure auction rules (ranking, window, triggers, capped extension, status, validation)
  src/services/        Database operations: the bid transaction with a row lock, listing, details
  src/app.js           Express routes and error mapping
  scripts/migrate.js   Applies docs/schema.sql
  scripts/seed.js      Idempotent demo data
  tests/unit/          Engine unit tests (no DB)
  tests/integration/   Bid transaction and concurrency tests (Postgres)
frontend/
  src/pages/           Auction listing, Create RFQ, Auction details
  src/components/      Status badge, countdown, form primitives
  src/lib/             API client, formatting, polling and server-clock hooks
docs/
  HLD.md, schema.sql
```

## Setup

### 1. Install

```bash
cd backend  && npm install
cd ../frontend && npm install
```

### 2. Environment variables

Copy `backend/.env.example` to `backend/.env` and fill it in. In Supabase, the
connection strings are under **Connect**.

| Variable | Value |
|---|---|
| `DATABASE_URL` | Transaction pooler URL (port 6543). Used by the running API. |
| `DIRECT_URL` | Session pooler URL (port 5432) or the direct connection. Used by `migrate` and `seed`. |
| `DATABASE_URL_TEST` | `DIRECT_URL` with `?schema=rfq_test` appended. Used only by integration tests. |
| `PORT` | API port, e.g. `4000` |
| `CORS_ORIGIN` | Frontend origin, e.g. `http://localhost:5173` |

Copy `frontend/.env.example` to `frontend/.env`:

| Variable | Value |
|---|---|
| `VITE_API_BASE_URL` | e.g. `http://localhost:4000/api` |

If the database password contains special characters, wrap each URL in double
quotes and URL-encode those characters in the password: `?` → `%3F`, `#` → `%23`,
`@` → `%40`, `*` → `%2A`.

Supabase's direct host (`db.<ref>.supabase.co`) is IPv6-only. If it does not
resolve on your network, use the session pooler for `DIRECT_URL` instead.

### 3. Database

```bash
cd backend
npm run migrate   # create tables (idempotent)
npm run seed      # clear and recreate demo data (idempotent; also applies the schema)
```

The seed creates five suppliers and one RFQ in each status:

| RFQ | Status | What it shows |
|---|---|---|
| RFQ-2026-001 | Closed | One rank-change extension, ended before the forced close |
| RFQ-2026-002 | Force Closed (INR) | Two extensions up to the forced close, then `EXTENSION_CAPPED` |
| RFQ-2026-003 | Active, **demo** | Closes ~3 min after seeding. X = 2 min, Y = 1 min, L1-change trigger, 3 bids already placed |
| RFQ-2026-004 | Active | Longer-running auction |
| RFQ-2026-005 | Scheduled (EUR) | Starts tomorrow |

The historical bids are replayed through the real bid code, so their extensions
and activity log come from the engine itself.

### 4. Run

```bash
cd backend  && npm run dev   # API on http://localhost:4000/api
cd frontend && npm run dev   # UI on http://localhost:5173
```

### 5. Demo walkthrough

1. Run `npm run seed` in `backend` and open http://localhost:5173.
2. Open **RFQ-2026-003**.
3. Within the last 2 minutes before close, use **Bid as** to pick a supplier that
   is not L1, and enter a total below the current L1.
4. The bid becomes L1 and the close time moves forward by 1 minute. The countdown
   flashes amber, and the activity log shows
   "L1 changed from … to …; extended by 1 min".
5. Repeated extensions stop at the forced close. After that, an L1 change logs
   **Capped** instead of extending.

## Tests

```bash
cd backend
npm test                  # engine unit tests: no database, under 1 second
npm run test:integration  # Postgres tests on the rfq_test schema; skipped if DATABASE_URL_TEST is unset
```

- **Unit tests** ([tests/unit](backend/tests/unit)) cover every engine rule:
  - ranking, ties, and only the latest bid counting
  - the inclusive trigger window
  - all three triggers, including "rank kept, so no change" and "first bid is an L1 change"
  - rolling and partial extensions, and the forced-close cap
  - derived statuses
  - create and bid validation
  - exact money arithmetic
- **Integration tests** ([tests/integration](backend/tests/integration)) cover:
  - two simultaneous in-window bids (via `Promise.all`), producing exactly one
    `AUCTION_EXTENDED` with the close time ≤ forced close
  - a burst of concurrent bids, which extends as a strict chain and stops at the cap
  - rollback of rejected bids
  - a bid after the close being rejected while the forced close is still in the future
  - the details payload

  These tests refuse to run unless the connection is on the test schema, so they
  never touch dev data.

## API

Every successful response includes `server_now` (UTC). Errors return
`{ "error": "<message>", "details"?: [...] }`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/suppliers` | Suppliers for the "Bid as" dropdown |
| GET | `/api/rfqs` | Listing: name/ID, current lowest bid, current close, forced close, status |
| POST | `/api/rfqs` | Create an RFQ with its auction configuration |
| GET | `/api/rfqs/:id` | Ranking (L1, L2, …) with quote details, all bids by price, X/Y config, activity log |
| POST | `/api/rfqs/:id/bids` | Submit a quote: one transaction with `SELECT … FOR UPDATE` on the RFQ |

Status codes:
- **400:** invalid input
- **404:** unknown RFQ or supplier
- **409:** the auction is not open, the bid is not lower than the supplier's
  previous bid, or the RFQ reference is a duplicate

## Auction rules

These are implemented exactly as listed in [HLD section 5](docs/HLD.md#5-auction-engine-rules).

- **Bid acceptance:** a bid is accepted only if `bid_start_at ≤ now ≤ current_bid_close_at`
  and its total (freight + origin + destination) is strictly lower than the
  supplier's own previous total.
- **Ranking:** only each supplier's latest bid counts. Bids sort by total,
  ascending, and ties go to the earlier submission.
- **Trigger window:** a bid is in the window if `now ≥ current_bid_close_at − X`.
  The configured trigger then decides whether to extend:
  - `BID_RECEIVED`: always.
  - `ANY_RANK_CHANGE`: when the supplier order changes. A new supplier entering
    the ranking counts as a change.
  - `L1_CHANGE`: when the rank-1 supplier changes. The first-ever bid counts.
- **Extension:** `new_close = min(current_close + Y, forced_close)`. If the close
  already equals the forced close, `EXTENSION_CAPPED` is logged and nothing moves.
- **Status:** derived from the timestamps, never stored.
  - `SCHEDULED` before the start.
  - `ACTIVE` until the current close.
  - Then `CLOSED`, or `FORCE_CLOSED` if extensions reached the forced close.

## Assumptions and extensions beyond the PDF

1. **`SCHEDULED` status.** It extends the PDF's three statuses (Active / Closed /
   Force Closed) on purpose. A buyer who has just created an RFQ needs to see it in
   the listing before bidding opens.
2. **No login.** There is one UI with no buyer/supplier role split. Suppliers are
   seeded, and bidders pick one from a **Bid as** dropdown that sends `supplier_id`.
   The carrier name is filled in automatically and read-only. Typed names were not
   used because typos would create phantom suppliers and break ranking.
3. **Currency per RFQ.** The RFQ has a currency (USD / INR / EUR, default USD), and
   all amounts are formatted with it. Charges are stored as `numeric(12,2)`, and
   the engine compares totals in integer cents.
4. **Re-bidding.** A supplier may re-bid any number of times, but each bid must be
   strictly lower than their own previous total. A supplier may bid above other
   suppliers. A total of zero is rejected.
5. **Quote fields.** Transit time is a whole number of days. Quote validity is a
   "valid until" date.
6. **One clock.** "Now" is the database clock, read after the RFQ row lock is
   taken. The UI countdown is driven by `server_now`, so a wrong client clock does
   not show a wrong timer. When an extension is picked up by polling, the countdown
   flashes and shows the old → new close time.
7. **Timezones.** Times are stored and compared in UTC, and shown in the browser's
   local time. The API requires timestamps with an explicit offset.
8. **Live updates by polling.** The details page polls every 3 s and the listing
   every 5 s. The HLD describes the scalable replacement (WebSockets or SSE over
   Postgres `LISTEN/NOTIFY`).
9. **Supabase hardening.** Row-level security is enabled on all tables, with no
   policies. This blocks Supabase's auto-generated public REST API. The backend
   connects as the table owner, so it is unaffected.
