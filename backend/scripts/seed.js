// Idempotent demo seed: clears all data, then recreates suppliers and RFQs in
// every status. Historical bids are replayed through submitBid() with a fixed
// clock, so their extensions and activity log come from the real engine.
// Usage: npm run seed   (uses DIRECT_URL)

import 'dotenv/config';
import { createPool } from '../src/db.js';
import { createRfq, submitBid } from '../src/services/auctionService.js';
import { applySchema } from './migrate.js';

const SUPPLIERS = ['Maersk', 'MSC', 'CMA CGM', 'Hapag-Lloyd', 'Ocean Network Express'];

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const isoDate = (d) => d.toISOString().slice(0, 10);

const pool = createPool(process.env.DIRECT_URL);

try {
  await applySchema(pool);
  await pool.query('TRUNCATE auction_events, bids, rfqs, suppliers RESTART IDENTITY CASCADE');

  const supplierIds = {};
  for (const name of SUPPLIERS) {
    const { rows } = await pool.query('INSERT INTO suppliers (name) VALUES ($1) RETURNING id', [name]);
    supplierIds[name] = rows[0].id;
  }

  const { rows } = await pool.query('SELECT clock_timestamp() AS now');
  const now = rows[0].now.getTime();
  const at = (offsetMs) => new Date(now + offsetMs);

  async function rfq(fields) {
    const { rfq: created } = await createRfq(pool, {
      currency: 'USD',
      ...fields,
      current_bid_close_at: fields.original_bid_close_at,
    });
    return created.id;
  }

  async function bid(rfqId, supplier, when, [freight, origin, destination], transitDays) {
    await submitBid(
      pool,
      rfqId,
      {
        supplier_id: supplierIds[supplier],
        freight_charges: freight,
        origin_charges: origin,
        destination_charges: destination,
        transit_time_days: transitDays,
        quote_valid_until: isoDate(at(30 * DAY)),
      },
      { now: when }
    );
  }

  // CLOSED: one rank-change extension, ended before reaching the forced close.
  const closeC = -DAY;
  const closed = await rfq({
    reference: 'RFQ-2026-001',
    name: 'Nhava Sheva → Rotterdam, 2×40ft HC',
    bid_start_at: at(closeC - 3 * HOUR),
    original_bid_close_at: at(closeC),
    forced_close_at: at(closeC + 30 * MIN),
    service_date: isoDate(at(7 * DAY)),
    trigger_window_minutes: 10,
    extension_minutes: 5,
    extension_trigger: 'ANY_RANK_CHANGE',
  });
  await bid(closed, 'Maersk', at(closeC - 60 * MIN), ['2400.00', '150.00', '200.00'], 24);
  await bid(closed, 'MSC', at(closeC - 45 * MIN), ['2300.00', '140.00', '210.00'], 26);
  await bid(closed, 'Maersk', at(closeC - 20 * MIN), ['2250.00', '150.00', '200.00'], 24);
  await bid(closed, 'CMA CGM', at(closeC - 5 * MIN), ['2200.00', '130.00', '190.00'], 25);

  // FORCE_CLOSED: repeated extensions until the cap, then an EXTENSION_CAPPED event.
  const closeF = -2 * HOUR;
  const forceClosed = await rfq({
    reference: 'RFQ-2026-002',
    name: 'Chennai → Singapore, LCL 12 CBM',
    currency: 'INR',
    bid_start_at: at(closeF - 2 * HOUR),
    original_bid_close_at: at(closeF),
    forced_close_at: at(closeF + 10 * MIN),
    service_date: isoDate(at(3 * DAY)),
    trigger_window_minutes: 10,
    extension_minutes: 5,
    extension_trigger: 'BID_RECEIVED',
  });
  await bid(forceClosed, 'Hapag-Lloyd', at(closeF - 50 * MIN), ['84000.00', '6500.00', '7000.00'], 9);
  await bid(forceClosed, 'Ocean Network Express', at(closeF - 5 * MIN), ['82000.00', '6000.00', '7500.00'], 10);
  await bid(forceClosed, 'Hapag-Lloyd', at(closeF + 2 * MIN), ['80500.00', '6500.00', '7000.00'], 9);
  await bid(forceClosed, 'Ocean Network Express', at(closeF + 9 * MIN), ['79000.00', '6000.00', '7500.00'], 10);

  // ACTIVE demo: closes ~3 minutes after seeding. X = 2 min, Y = 1 min, L1 change.
  const demo = await rfq({
    reference: 'RFQ-2026-003',
    name: 'DEMO: Mundra → Jebel Ali, 1×20ft',
    bid_start_at: at(-20 * MIN),
    original_bid_close_at: at(3 * MIN),
    forced_close_at: at(10 * MIN),
    service_date: isoDate(at(5 * DAY)),
    trigger_window_minutes: 2,
    extension_minutes: 1,
    extension_trigger: 'L1_CHANGE',
  });
  await bid(demo, 'Maersk', at(-15 * MIN), ['1500.00', '120.00', '230.00'], 6);
  await bid(demo, 'Hapag-Lloyd', at(-10 * MIN), ['1450.00', '110.00', '230.00'], 7);
  await bid(demo, 'MSC', at(-5 * MIN), ['1480.00', '115.00', '225.00'], 6);

  // ACTIVE: longer-running auction.
  const active = await rfq({
    reference: 'RFQ-2026-004',
    name: 'Shanghai → Los Angeles, 1×40ft',
    bid_start_at: at(-HOUR),
    original_bid_close_at: at(2 * HOUR),
    forced_close_at: at(3 * HOUR),
    service_date: isoDate(at(14 * DAY)),
    trigger_window_minutes: 10,
    extension_minutes: 5,
    extension_trigger: 'BID_RECEIVED',
  });
  await bid(active, 'Ocean Network Express', at(-30 * MIN), ['3100.00', '180.00', '260.00'], 18);

  // SCHEDULED: starts tomorrow.
  await rfq({
    reference: 'RFQ-2026-005',
    name: 'Hamburg → New York, 3×40ft',
    currency: 'EUR',
    bid_start_at: at(DAY),
    original_bid_close_at: at(DAY + 2 * HOUR),
    forced_close_at: at(DAY + 3 * HOUR),
    service_date: isoDate(at(20 * DAY)),
    trigger_window_minutes: 15,
    extension_minutes: 10,
    extension_trigger: 'ANY_RANK_CHANGE',
  });

  console.log(`Seeded ${SUPPLIERS.length} suppliers and 5 RFQs into "${pool.schema}".`);
  console.log('Demo RFQ RFQ-2026-003 closes in ~3 minutes.');
} finally {
  await pool.end();
}
