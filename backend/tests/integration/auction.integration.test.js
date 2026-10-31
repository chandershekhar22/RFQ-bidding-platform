// DB-backed tests for the bid transaction. They run against the schema named in
// DATABASE_URL_TEST (?schema=rfq_test) and are skipped when it is not set.
// Usage: npm run test:integration

import 'dotenv/config';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool } from '../../src/db.js';
import { createRfq, getRfqDetails, submitBid } from '../../src/services/auctionService.js';
import { applySchema } from '../../scripts/migrate.js';

const url = process.env.DATABASE_URL_TEST;
const MIN = 60_000;

describe.skipIf(!url)('bid transaction (Postgres)', () => {
  let pool;
  const supplier = {};

  beforeAll(async () => {
    pool = createPool(url);
    if (pool.schema === 'public') {
      throw new Error('DATABASE_URL_TEST must point at a separate schema (?schema=rfq_test).');
    }
    await applySchema(pool);
    // Safety net before any TRUNCATE: the connection must really be on the test schema.
    const { rows } = await pool.query('SELECT current_schema() AS schema');
    if (rows[0].schema !== pool.schema) {
      throw new Error(`Connected to schema "${rows[0].schema}", expected "${pool.schema}". Refusing to run.`);
    }
  });

  afterAll(async () => {
    await pool?.query('TRUNCATE auction_events, bids, rfqs, suppliers RESTART IDENTITY CASCADE');
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE auction_events, bids, rfqs, suppliers RESTART IDENTITY CASCADE');
    const names = ['Maersk', 'MSC', 'CMA CGM', 'Hapag-Lloyd', 'ONE', 'Evergreen', 'COSCO', 'Yang Ming'];
    const { rows } = await pool.query(
      'INSERT INTO suppliers (name) SELECT unnest($1::text[]) RETURNING id, name',
      [names]
    );
    for (const row of rows) supplier[row.name] = row.id;
  });

  async function dbNow() {
    const { rows } = await pool.query('SELECT clock_timestamp() AS now');
    return rows[0].now.getTime();
  }

  // Times are relative to the database clock (ms offsets).
  async function makeRfq({ close, forced, x, y, trigger, british = true }) {
    const now = await dbNow();
    const { rfq } = await createRfq(pool, {
      reference: `T-${Math.random().toString(36).slice(2, 10)}`,
      name: 'Integration test RFQ',
      currency: 'USD',
      bid_start_at: new Date(now - 10 * MIN),
      original_bid_close_at: new Date(now + close),
      current_bid_close_at: new Date(now + close),
      forced_close_at: new Date(now + forced),
      service_date: '2026-12-01',
      british_auction_enabled: british,
      trigger_window_minutes: british ? x : null,
      extension_minutes: british ? y : null,
      extension_trigger: british ? trigger : null,
    });
    return rfq;
  }

  const bid = (rfqId, name, freight) =>
    submitBid(pool, rfqId, {
      supplier_id: supplier[name],
      freight_charges: freight,
      origin_charges: '0',
      destination_charges: '0',
      transit_time_days: 10,
      quote_valid_until: '2026-12-31',
    });

  async function eventsOf(rfqId, type) {
    const { rows } = await pool.query(
      'SELECT * FROM auction_events WHERE rfq_id = $1 AND event_type = $2 ORDER BY seq',
      [rfqId, type]
    );
    return rows;
  }

  async function closeOf(rfqId) {
    const { rows } = await pool.query(
      'SELECT current_bid_close_at, forced_close_at FROM rfqs WHERE id = $1',
      [rfqId]
    );
    return { close: rows[0].current_bid_close_at.getTime(), forced: rows[0].forced_close_at.getTime() };
  }

  it('two simultaneous in-window bids produce exactly one extension and never pass the forced close', async () => {
    // Y (5 min) is larger than the room left (1 min): the first bid extends to the cap,
    // the second must see the updated close under the lock and log EXTENSION_CAPPED.
    const rfq = await makeRfq({ close: 2 * MIN, forced: 3 * MIN, x: 5, y: 5, trigger: 'BID_RECEIVED' });

    const results = await Promise.all([bid(rfq.id, 'Maersk', '1000.00'), bid(rfq.id, 'MSC', '990.00')]);

    expect(results.map((r) => r.extension.type).sort()).toEqual(['CAPPED', 'EXTENDED']);
    expect(await eventsOf(rfq.id, 'AUCTION_EXTENDED')).toHaveLength(1);
    expect(await eventsOf(rfq.id, 'EXTENSION_CAPPED')).toHaveLength(1);
    expect(await eventsOf(rfq.id, 'BID_SUBMITTED')).toHaveLength(2);
    const { close, forced } = await closeOf(rfq.id);
    expect(close).toBeLessThanOrEqual(forced);
    expect(close).toBe(forced);
  });

  it('two simultaneous equal L1-taking bids extend once (tie goes to the first committed)', async () => {
    const rfq = await makeRfq({ close: 2 * MIN, forced: 30 * MIN, x: 5, y: 1, trigger: 'L1_CHANGE' });
    await bid(rfq.id, 'Maersk', '1000.00'); // first-ever bid: L1 change, extends once
    const before = await closeOf(rfq.id);

    await Promise.all([bid(rfq.id, 'MSC', '900.00'), bid(rfq.id, 'CMA CGM', '900.00')]);

    // One of the two takes L1 from Maersk; the other ties but is later, so L1 does not change again.
    expect(await eventsOf(rfq.id, 'AUCTION_EXTENDED')).toHaveLength(2);
    const after = await closeOf(rfq.id);
    expect(after.close - before.close).toBe(1 * MIN);
  });

  it('a burst of concurrent bids extends in a strict chain and stops at the forced close', async () => {
    const rfq = await makeRfq({ close: 2 * MIN, forced: 5 * MIN, x: 10, y: 1, trigger: 'BID_RECEIVED' });
    const names = ['Maersk', 'MSC', 'CMA CGM', 'Hapag-Lloyd', 'ONE', 'Evergreen', 'COSCO'];

    await Promise.all(names.map((n, i) => bid(rfq.id, n, String(1000 - i))));

    const extended = await eventsOf(rfq.id, 'AUCTION_EXTENDED');
    const capped = await eventsOf(rfq.id, 'EXTENSION_CAPPED');
    expect(extended).toHaveLength(3); // 2 -> 3 -> 4 -> 5 minutes (cap)
    expect(capped).toHaveLength(names.length - 3);
    for (let i = 1; i < extended.length; i++) {
      expect(extended[i].old_close_at.getTime()).toBe(extended[i - 1].new_close_at.getTime());
    }
    const { close, forced } = await closeOf(rfq.id);
    expect(close).toBe(forced);
  });

  it('a bid outside the trigger window is stored without extending', async () => {
    const rfq = await makeRfq({ close: 30 * MIN, forced: 60 * MIN, x: 10, y: 5, trigger: 'BID_RECEIVED' });
    const res = await bid(rfq.id, 'Maersk', '1000.00');

    expect(res.extension).toBeNull();
    expect(await eventsOf(rfq.id, 'BID_SUBMITTED')).toHaveLength(1);
    expect(await eventsOf(rfq.id, 'AUCTION_EXTENDED')).toHaveLength(0);
    expect((await closeOf(rfq.id)).close).toBe(new Date(rfq.original_bid_close_at).getTime());
  });

  it('a rejected bid rolls back: no bid row, no event, no extension', async () => {
    const rfq = await makeRfq({ close: 2 * MIN, forced: 30 * MIN, x: 5, y: 5, trigger: 'BID_RECEIVED' });
    await bid(rfq.id, 'Maersk', '1000.00');
    const closeBefore = await closeOf(rfq.id);

    await expect(bid(rfq.id, 'Maersk', '1000.00')).rejects.toMatchObject({ status: 409 });

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM bids WHERE rfq_id = $1', [rfq.id]);
    expect(rows[0].n).toBe(1);
    expect(await eventsOf(rfq.id, 'BID_SUBMITTED')).toHaveLength(1);
    expect(await closeOf(rfq.id)).toEqual(closeBefore);
  });

  it('rejects bids after the current close even though the forced close is later', async () => {
    const rfq = await makeRfq({ close: -1 * MIN, forced: 30 * MIN, x: 5, y: 5, trigger: 'BID_RECEIVED' });
    await expect(bid(rfq.id, 'Maersk', '1000.00')).rejects.toMatchObject({
      status: 409,
      message: 'Bidding is closed for this RFQ.',
    });
  });

  it('a standard RFQ (British Auction off) never extends, even with concurrent L1 changes at the deadline', async () => {
    const rfq = await makeRfq({ close: 1 * MIN, forced: 30 * MIN, british: false });
    expect(rfq.british_auction_enabled).toBe(false);

    await bid(rfq.id, 'Maersk', '1000.00');
    await Promise.all([bid(rfq.id, 'MSC', '900.00'), bid(rfq.id, 'CMA CGM', '800.00')]);

    expect(await eventsOf(rfq.id, 'BID_SUBMITTED')).toHaveLength(3);
    expect(await eventsOf(rfq.id, 'AUCTION_EXTENDED')).toHaveLength(0);
    expect(await eventsOf(rfq.id, 'EXTENSION_CAPPED')).toHaveLength(0);
    expect((await closeOf(rfq.id)).close).toBe(new Date(rfq.original_bid_close_at).getTime());

    const d = await getRfqDetails(pool, rfq.id);
    expect(d.config).toEqual({
      british_auction_enabled: false,
      trigger_window_minutes: null,
      extension_minutes: null,
      extension_trigger: null,
    });
  });

  it('the database rejects an inconsistent British Auction configuration', async () => {
    const insert = (british, x) =>
      pool.query(
        `INSERT INTO rfqs (reference, name, bid_start_at, original_bid_close_at, current_bid_close_at,
                           forced_close_at, service_date, british_auction_enabled,
                           trigger_window_minutes, extension_minutes, extension_trigger)
         VALUES ($1, 'x', now(), now() + interval '1 hour', now() + interval '1 hour',
                 now() + interval '2 hours', '2026-12-01', $2, $3, $3, $4)`,
        [`BAD-${british}`, british, x, x ? 'BID_RECEIVED' : null]
      );
    await expect(insert(true, null)).rejects.toMatchObject({ constraint: 'rfq_auction_config' });
    await expect(insert(false, 5)).rejects.toMatchObject({ constraint: 'rfq_auction_config' });
  });

  it('details return the ranking, all bids by price and the activity log', async () => {
    const rfq = await makeRfq({ close: 2 * MIN, forced: 30 * MIN, x: 5, y: 1, trigger: 'ANY_RANK_CHANGE' });
    await bid(rfq.id, 'Maersk', '1000.00');
    await bid(rfq.id, 'MSC', '1100.00');
    await bid(rfq.id, 'MSC', '950.00');

    const d = await getRfqDetails(pool, rfq.id);
    expect(d.ranking.map((r) => [r.carrier_name, r.rank, r.total])).toEqual([
      ['MSC', 1, '950.00'],
      ['Maersk', 2, '1000.00'],
    ]);
    expect(d.bids.map((b) => b.total)).toEqual(['950.00', '1000.00', '1100.00']);
    expect(d.rfq.status).toBe('ACTIVE');
    const reasons = d.events.filter((e) => e.event_type === 'AUCTION_EXTENDED').map((e) => e.reason);
    expect(reasons).toEqual([
      'Ranking changed: Maersk entered the ranking at L1; extended by 1 min',
      'Ranking changed: MSC entered the ranking at L2; extended by 1 min',
      'Ranking changed: MSC moved from L2 to L1; extended by 1 min',
    ]);
  });
});
