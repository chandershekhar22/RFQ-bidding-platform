// British Auction engine: pure functions, no I/O.
// Timestamps may be Date objects or ISO strings; all comparisons are in epoch ms (UTC).

import { toCents } from './money.js';

export const TRIGGERS = ['BID_RECEIVED', 'ANY_RANK_CHANGE', 'L1_CHANGE'];
export const STATUS = {
  SCHEDULED: 'SCHEDULED',
  ACTIVE: 'ACTIVE',
  CLOSED: 'CLOSED',
  FORCE_CLOSED: 'FORCE_CLOSED',
};

const MINUTE_MS = 60_000;
const ms = (t) => new Date(t).getTime();

export class BidRejectedError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function bidTotalCents({ freight_charges, origin_charges, destination_charges }) {
  return toCents(freight_charges) + toCents(origin_charges) + toCents(destination_charges);
}

/**
 * Rank suppliers by their latest bid.
 * bids: [{ supplier_id, supplier_name, total, seq }]; total may be cents (number) via
 * `total_cents` or a numeric string via `total`.
 * Returns [{ ...latestBid, total_cents, rank }] sorted L1, L2, ...
 */
export function rankBids(bids) {
  const latest = new Map();
  for (const bid of bids) {
    const current = latest.get(bid.supplier_id);
    if (!current || bid.seq > current.seq) latest.set(bid.supplier_id, bid);
  }
  return [...latest.values()]
    .map((b) => ({ ...b, total_cents: b.total_cents ?? toCents(b.total) }))
    .sort((a, b) => a.total_cents - b.total_cents || a.seq - b.seq)
    .map((b, i) => ({ ...b, rank: i + 1 }));
}

export function deriveStatus(rfq, now) {
  const t = ms(now);
  const close = ms(rfq.current_bid_close_at);
  if (t < ms(rfq.bid_start_at)) return STATUS.SCHEDULED;
  if (t <= close) return STATUS.ACTIVE;
  return close === ms(rfq.forced_close_at) ? STATUS.FORCE_CLOSED : STATUS.CLOSED;
}

/** Throws BidRejectedError if the auction is not accepting bids at `now`. */
export function assertBiddingOpen(rfq, now) {
  const t = ms(now);
  if (t < ms(rfq.bid_start_at)) {
    throw new BidRejectedError(409, 'Bidding has not started yet for this RFQ.');
  }
  if (t > ms(rfq.current_bid_close_at)) {
    throw new BidRejectedError(409, 'Bidding is closed for this RFQ.');
  }
}

/** Throws BidRejectedError unless newTotalCents is strictly below the supplier's previous total. */
export function assertLowerThanPrevious(previousTotalCents, newTotalCents) {
  if (newTotalCents <= 0) {
    throw new BidRejectedError(400, 'Bid total must be greater than zero.');
  }
  if (previousTotalCents != null && newTotalCents >= previousTotalCents) {
    throw new BidRejectedError(
      409,
      'New bid must be lower than your previous bid on this RFQ.'
    );
  }
}

export function isInTriggerWindow(rfq, bidTime) {
  const windowStart = ms(rfq.current_bid_close_at) - rfq.trigger_window_minutes * MINUTE_MS;
  return ms(bidTime) >= windowStart;
}

/**
 * Decide whether the configured trigger fired, given rankings before and after the bid.
 * Returns { fired, reason }.
 */
export function evaluateTrigger(trigger, before, after, bidderId) {
  const bidder = after.find((r) => r.supplier_id === bidderId);
  const bidderName = bidder?.supplier_name ?? 'Supplier';

  if (trigger === 'BID_RECEIVED') {
    return { fired: true, reason: `Bid received from ${bidderName} in the trigger window` };
  }

  if (trigger === 'ANY_RANK_CHANGE') {
    const changed =
      before.length !== after.length ||
      before.some((r, i) => r.supplier_id !== after[i].supplier_id);
    if (!changed) return { fired: false, reason: null };
    const prev = before.find((r) => r.supplier_id === bidderId);
    const reason = prev
      ? `Ranking changed: ${bidderName} moved from L${prev.rank} to L${bidder.rank}`
      : `Ranking changed: ${bidderName} entered the ranking at L${bidder.rank}`;
    return { fired: true, reason };
  }

  if (trigger === 'L1_CHANGE') {
    const oldL1 = before[0];
    const newL1 = after[0];
    if (oldL1 && oldL1.supplier_id === newL1.supplier_id) return { fired: false, reason: null };
    const reason = oldL1
      ? `L1 changed from ${oldL1.supplier_name} to ${newL1.supplier_name}`
      : `${newL1.supplier_name} became the first L1`;
    return { fired: true, reason };
  }

  throw new Error(`Unknown extension trigger: ${trigger}`);
}

/**
 * Rolling, capped extension. Returns
 *   { type: 'EXTENDED', oldClose, newClose } or { type: 'CAPPED', oldClose }.
 */
export function computeExtension(rfq) {
  const oldClose = ms(rfq.current_bid_close_at);
  const forced = ms(rfq.forced_close_at);
  if (oldClose >= forced) return { type: 'CAPPED', oldClose: new Date(oldClose) };
  const newClose = Math.min(oldClose + rfq.extension_minutes * MINUTE_MS, forced);
  return { type: 'EXTENDED', oldClose: new Date(oldClose), newClose: new Date(newClose) };
}

/**
 * Full decision for one incoming bid. Throws BidRejectedError for invalid bids.
 *
 * existingBids: all prior bids on the RFQ [{ supplier_id, supplier_name, total, seq }]
 * newBid: { supplier_id, supplier_name, freight_charges, origin_charges, destination_charges }
 *
 * Returns {
 *   totalCents, before, after,
 *   extension: null | { type: 'EXTENDED'|'CAPPED', oldClose, newClose?, trigger, reason }
 * }
 */
export function evaluateBid({ rfq, existingBids, newBid, now }) {
  assertBiddingOpen(rfq, now);

  const before = rankBids(existingBids);
  const totalCents = bidTotalCents(newBid);
  const previous = before.find((r) => r.supplier_id === newBid.supplier_id);
  assertLowerThanPrevious(previous?.total_cents, totalCents);

  const after = rankBids([
    ...existingBids,
    { ...newBid, total_cents: totalCents, seq: Number.POSITIVE_INFINITY },
  ]);

  // Standard RFQs (British Auction off) have a fixed close time: never extend.
  let extension = null;
  if (rfq.british_auction_enabled !== false && isInTriggerWindow(rfq, now)) {
    const trigger = rfq.extension_trigger;
    const { fired, reason } = evaluateTrigger(trigger, before, after, newBid.supplier_id);
    if (fired) {
      const result = computeExtension(rfq);
      if (result.type === 'EXTENDED') {
        const capped = result.newClose.getTime() === ms(rfq.forced_close_at);
        const added = Math.round((result.newClose - result.oldClose) / MINUTE_MS);
        extension = {
          ...result,
          trigger,
          reason: `${reason}; extended by ${added} min${capped ? ' (reached forced close)' : ''}`,
        };
      } else {
        extension = {
          ...result,
          trigger,
          reason: `${reason}; no extension, close time already equals forced close`,
        };
      }
    }
  }

  return { totalCents, before, after, extension };
}
