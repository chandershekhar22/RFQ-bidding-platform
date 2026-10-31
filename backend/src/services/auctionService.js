// Database-facing auction operations. Business rules live in ../engine;
// this module loads state, calls the engine, and persists the outcome.
// "Now" always comes from the database clock so every timestamp shares one clock.

import { withTransaction } from '../db.js';
import { deriveStatus, evaluateBid, rankBids } from '../engine/auction.js';
import { centsToString } from '../engine/money.js';
import { HttpError } from '../errors.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function dbNow(db) {
  const { rows } = await db.query('SELECT clock_timestamp() AS now');
  return rows[0].now;
}

function assertUuid(id, what) {
  if (!UUID.test(id)) throw new HttpError(404, `${what} not found.`);
}

function rfqConfig(rfq) {
  return {
    british_auction_enabled: rfq.british_auction_enabled,
    trigger_window_minutes: rfq.trigger_window_minutes,
    extension_minutes: rfq.extension_minutes,
    extension_trigger: rfq.extension_trigger,
  };
}

export async function listSuppliers(pool) {
  const { rows } = await pool.query('SELECT id, name FROM suppliers ORDER BY name');
  return { suppliers: rows, server_now: await dbNow(pool) };
}

export async function createRfq(pool, rfq) {
  try {
    const { rows } = await pool.query(
      `INSERT INTO rfqs (reference, name, currency, bid_start_at, original_bid_close_at,
                         current_bid_close_at, forced_close_at, service_date,
                         british_auction_enabled, trigger_window_minutes, extension_minutes,
                         extension_trigger)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        rfq.reference, rfq.name, rfq.currency, rfq.bid_start_at, rfq.original_bid_close_at,
        rfq.current_bid_close_at, rfq.forced_close_at, rfq.service_date,
        rfq.british_auction_enabled ?? true, rfq.trigger_window_minutes, rfq.extension_minutes,
        rfq.extension_trigger,
      ]
    );
    const now = await dbNow(pool);
    return { rfq: { ...rows[0], status: deriveStatus(rows[0], now) }, server_now: now };
  } catch (err) {
    if (err.code === '23505') {
      throw new HttpError(409, `An RFQ with reference "${rfq.reference}" already exists.`);
    }
    throw err;
  }
}

export async function listRfqs(pool) {
  const { rows } = await pool.query(
    `WITH latest AS (
       SELECT DISTINCT ON (rfq_id, supplier_id) rfq_id, total
       FROM bids
       ORDER BY rfq_id, supplier_id, seq DESC
     )
     SELECT r.*,
            (SELECT min(l.total) FROM latest l WHERE l.rfq_id = r.id) AS lowest_bid,
            (SELECT count(*)::int FROM bids b WHERE b.rfq_id = r.id) AS bid_count,
            clock_timestamp() AS server_now
     FROM rfqs r
     ORDER BY r.created_at DESC`
  );
  const now = rows[0]?.server_now ?? (await dbNow(pool));
  return {
    rfqs: rows.map(({ server_now, ...r }) => ({ ...r, status: deriveStatus(r, now) })),
    server_now: now,
  };
}

export async function getRfqDetails(pool, rfqId) {
  assertUuid(rfqId, 'RFQ');
  const { rows: rfqRows } = await pool.query('SELECT * FROM rfqs WHERE id = $1', [rfqId]);
  if (!rfqRows.length) throw new HttpError(404, 'RFQ not found.');
  const rfq = rfqRows[0];

  const [{ rows: bids }, { rows: events }, now] = await Promise.all([
    pool.query(
      `SELECT b.*, b.carrier_name AS supplier_name
       FROM bids b WHERE b.rfq_id = $1
       ORDER BY b.total ASC, b.seq ASC`,
      [rfqId]
    ),
    pool.query(
      `SELECT e.*, b.carrier_name, b.total
       FROM auction_events e LEFT JOIN bids b ON b.id = e.bid_id
       WHERE e.rfq_id = $1
       ORDER BY e.seq ASC`,
      [rfqId]
    ),
    dbNow(pool),
  ]);

  const ranking = rankBids(bids).map(({ total_cents, supplier_name, ...b }) => b);

  return {
    rfq: { ...rfq, status: deriveStatus(rfq, now) },
    config: rfqConfig(rfq),
    ranking, // each supplier's latest bid, L1 first
    bids, // every bid submitted, sorted by price
    events,
    server_now: now,
  };
}

/**
 * Submit a bid: one transaction, RFQ row locked so concurrent bids serialise.
 * `options.now` overrides the clock and exists only for the seed script,
 * which replays historical bids.
 */
export async function submitBid(pool, rfqId, input, options = {}) {
  assertUuid(rfqId, 'RFQ');
  assertUuid(input.supplier_id, 'Supplier');

  return withTransaction(pool, async (client) => {
    const { rows: rfqRows } = await client.query('SELECT * FROM rfqs WHERE id = $1 FOR UPDATE', [
      rfqId,
    ]);
    if (!rfqRows.length) throw new HttpError(404, 'RFQ not found.');
    const rfq = rfqRows[0];

    const { rows: supplierRows } = await client.query('SELECT id, name FROM suppliers WHERE id = $1', [
      input.supplier_id,
    ]);
    if (!supplierRows.length) throw new HttpError(404, 'Supplier not found.');
    const supplier = supplierRows[0];

    // Read the clock only after the lock is held, so a bid that waited is judged at its real time.
    const now = options.now ?? (await dbNow(client));

    const { rows: existingBids } = await client.query(
      'SELECT supplier_id, carrier_name AS supplier_name, total, seq FROM bids WHERE rfq_id = $1',
      [rfqId]
    );

    const decision = evaluateBid({
      rfq,
      existingBids,
      newBid: { ...input, supplier_id: supplier.id, supplier_name: supplier.name },
      now,
    });

    const { rows: bidRows } = await client.query(
      `INSERT INTO bids (rfq_id, supplier_id, carrier_name, freight_charges, origin_charges,
                         destination_charges, transit_time_days, quote_valid_until, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        rfqId, supplier.id, supplier.name, input.freight_charges, input.origin_charges,
        input.destination_charges, input.transit_time_days, input.quote_valid_until, now,
      ]
    );
    const bid = bidRows[0];
    const rank = decision.after.find((r) => r.supplier_id === supplier.id).rank;

    await client.query(
      `INSERT INTO auction_events (rfq_id, bid_id, event_type, reason, created_at)
       VALUES ($1, $2, 'BID_SUBMITTED', $3, $4)`,
      [
        rfqId,
        bid.id,
        `${supplier.name} bid ${rfq.currency} ${centsToString(decision.totalCents)} (now L${rank})`,
        now,
      ]
    );

    let currentClose = rfq.current_bid_close_at;
    const ext = decision.extension;
    if (ext?.type === 'EXTENDED') {
      await client.query('UPDATE rfqs SET current_bid_close_at = $2 WHERE id = $1', [
        rfqId,
        ext.newClose,
      ]);
      currentClose = ext.newClose;
      await client.query(
        `INSERT INTO auction_events
           (rfq_id, bid_id, event_type, trigger_type, old_close_at, new_close_at, reason, created_at)
         VALUES ($1, $2, 'AUCTION_EXTENDED', $3, $4, $5, $6, $7)`,
        [rfqId, bid.id, ext.trigger, ext.oldClose, ext.newClose, ext.reason, now]
      );
    } else if (ext?.type === 'CAPPED') {
      await client.query(
        `INSERT INTO auction_events
           (rfq_id, bid_id, event_type, trigger_type, old_close_at, new_close_at, reason, created_at)
         VALUES ($1, $2, 'EXTENSION_CAPPED', $3, $4, $4, $5, $6)`,
        [rfqId, bid.id, ext.trigger, ext.oldClose, ext.reason, now]
      );
    }

    const updated = { ...rfq, current_bid_close_at: currentClose };
    return {
      bid: { ...bid, rank },
      extension: ext
        ? {
            type: ext.type,
            trigger: ext.trigger,
            old_close_at: ext.oldClose,
            new_close_at: ext.newClose ?? ext.oldClose,
            reason: ext.reason,
          }
        : null,
      rfq: {
        id: rfq.id,
        current_bid_close_at: currentClose,
        forced_close_at: rfq.forced_close_at,
        status: deriveStatus(updated, now),
      },
      server_now: now,
    };
  });
}
