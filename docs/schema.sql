-- RFQ British Auction: database schema (PostgreSQL / Supabase)
--
-- Tables are created unqualified so the same file can be applied to the
-- default schema (dev) or to rfq_test (integration tests) via search_path.
-- All timestamps are timestamptz and stored in UTC.
-- Money is numeric(12,2), never float.
-- gen_random_uuid() is built into PostgreSQL 13+ (Supabase runs 15+).

-- Suppliers (carriers). Seeded; the UI's "Bid as" dropdown sends supplier_id.
CREATE TABLE IF NOT EXISTS suppliers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- One row per RFQ, including its British Auction configuration.
-- Status is NOT stored; it is derived from the timestamps (see HLD).
CREATE TABLE IF NOT EXISTS rfqs (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference               text NOT NULL UNIQUE,          -- RFQ Reference ID
  name                    text NOT NULL,                 -- RFQ Name
  currency                char(3) NOT NULL DEFAULT 'USD'
                          CHECK (currency IN ('USD', 'INR', 'EUR')),
  bid_start_at            timestamptz NOT NULL,
  original_bid_close_at   timestamptz NOT NULL,
  current_bid_close_at    timestamptz NOT NULL,          -- moves forward on extensions
  forced_close_at         timestamptz NOT NULL,
  service_date            date NOT NULL,                 -- Pickup / Service Date
  trigger_window_minutes  integer NOT NULL CHECK (trigger_window_minutes > 0), -- X
  extension_minutes       integer NOT NULL CHECK (extension_minutes > 0),      -- Y
  extension_trigger       text NOT NULL
                          CHECK (extension_trigger IN ('BID_RECEIVED', 'ANY_RANK_CHANGE', 'L1_CHANGE')),
  created_at              timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT rfq_time_order CHECK (bid_start_at < original_bid_close_at
                                   AND original_bid_close_at < forced_close_at),
  -- PDF rule: the auction must never extend beyond the forced close time.
  CONSTRAINT rfq_close_within_cap CHECK (current_bid_close_at >= original_bid_close_at
                                         AND current_bid_close_at <= forced_close_at)
);

-- Every quote ever submitted. Only each supplier's latest bid counts for ranking.
CREATE TABLE IF NOT EXISTS bids (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq                  bigint GENERATED ALWAYS AS IDENTITY UNIQUE, -- strict submission order (tie-break)
  rfq_id               uuid NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
  supplier_id          uuid NOT NULL REFERENCES suppliers(id),
  carrier_name         text NOT NULL,                  -- snapshot of supplier name at bid time
  freight_charges      numeric(12,2) NOT NULL CHECK (freight_charges >= 0),
  origin_charges       numeric(12,2) NOT NULL CHECK (origin_charges >= 0),
  destination_charges  numeric(12,2) NOT NULL CHECK (destination_charges >= 0),
  total                numeric(12,2) GENERATED ALWAYS AS
                         (freight_charges + origin_charges + destination_charges) STORED,
  transit_time_days    integer NOT NULL CHECK (transit_time_days > 0),
  quote_valid_until    date NOT NULL,                  -- Validity of Quote
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bids_rfq_supplier_idx ON bids (rfq_id, supplier_id, seq DESC);
CREATE INDEX IF NOT EXISTS bids_rfq_total_idx    ON bids (rfq_id, total);

-- Append-only activity log, written in the same transaction as the bid.
CREATE TABLE IF NOT EXISTS auction_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq           bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  rfq_id        uuid NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
  bid_id        uuid REFERENCES bids(id) ON DELETE CASCADE,
  event_type    text NOT NULL
                CHECK (event_type IN ('BID_SUBMITTED', 'AUCTION_EXTENDED', 'EXTENSION_CAPPED')),
  trigger_type  text CHECK (trigger_type IN ('BID_RECEIVED', 'ANY_RANK_CHANGE', 'L1_CHANGE')),
  old_close_at  timestamptz,
  new_close_at  timestamptz,
  reason        text,                                  -- e.g. "L1 changed from Maersk to CMA CGM"
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS auction_events_rfq_idx ON auction_events (rfq_id, seq);

-- Supabase exposes the public schema through its auto-generated REST API.
-- RLS with no policies blocks that path; the backend connects as the table
-- owner, which bypasses RLS, so the app is unaffected.
ALTER TABLE suppliers      ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfqs           ENABLE ROW LEVEL SECURITY;
ALTER TABLE bids           ENABLE ROW LEVEL SECURITY;
ALTER TABLE auction_events ENABLE ROW LEVEL SECURITY;
