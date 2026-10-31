import { describe, it, expect } from 'vitest';
import {
  BidRejectedError,
  bidTotalCents,
  computeExtension,
  deriveStatus,
  evaluateBid,
  evaluateTrigger,
  isInTriggerWindow,
  rankBids,
} from '../../src/engine/auction.js';

// Bid close 18:00, forced close 18:30, X = 10 min, Y = 5 min (the PDF's example).
const T = (hhmmss) => `2026-11-01T${hhmmss}Z`;
const rfqWith = (overrides = {}) => ({
  bid_start_at: T('17:00:00'),
  original_bid_close_at: T('18:00:00'),
  current_bid_close_at: T('18:00:00'),
  forced_close_at: T('18:30:00'),
  trigger_window_minutes: 10,
  extension_minutes: 5,
  extension_trigger: 'BID_RECEIVED',
  ...overrides,
});

const MAERSK = { supplier_id: 'maersk', supplier_name: 'Maersk' };
const CMA = { supplier_id: 'cma', supplier_name: 'CMA CGM' };
const MSC = { supplier_id: 'msc', supplier_name: 'MSC' };

const existing = (supplier, total, seq) => ({ ...supplier, total, seq });
const quote = (supplier, freight, origin = '0', destination = '0') => ({
  ...supplier,
  freight_charges: freight,
  origin_charges: origin,
  destination_charges: destination,
});

describe('bidTotalCents', () => {
  it('sums freight + origin + destination exactly (no float error)', () => {
    expect(bidTotalCents(quote(MAERSK, '0.10', '0.20', '0.30'))).toBe(60);
    expect(bidTotalCents(quote(MAERSK, '1000.5', '250.25', '99.99'))).toBe(135074);
  });
});

describe('rankBids', () => {
  it('ranks by total ascending, L1 first', () => {
    const ranked = rankBids([existing(MAERSK, '900.00', 1), existing(CMA, '800.00', 2)]);
    expect(ranked.map((r) => [r.supplier_id, r.rank])).toEqual([['cma', 1], ['maersk', 2]]);
  });

  it('breaks ties by earlier submission', () => {
    const ranked = rankBids([existing(CMA, '800.00', 5), existing(MAERSK, '800.00', 3)]);
    expect(ranked.map((r) => r.supplier_id)).toEqual(['maersk', 'cma']);
  });

  it("counts only each supplier's latest bid", () => {
    const ranked = rankBids([
      existing(MAERSK, '1000.00', 1),
      existing(CMA, '900.00', 2),
      existing(MAERSK, '850.00', 3),
    ]);
    expect(ranked).toHaveLength(2);
    expect(ranked.find((r) => r.supplier_id === 'maersk').total_cents).toBe(85000);
  });

  it('returns an empty ranking for no bids', () => {
    expect(rankBids([])).toEqual([]);
  });
});

describe('deriveStatus', () => {
  it('is SCHEDULED before bid start', () => {
    expect(deriveStatus(rfqWith(), T('16:59:59'))).toBe('SCHEDULED');
  });

  it('is ACTIVE from start through current close, inclusive', () => {
    expect(deriveStatus(rfqWith(), T('17:00:00'))).toBe('ACTIVE');
    expect(deriveStatus(rfqWith(), T('18:00:00'))).toBe('ACTIVE');
  });

  it('is CLOSED after current close when the cap was not reached', () => {
    expect(deriveStatus(rfqWith(), T('18:00:01'))).toBe('CLOSED');
    expect(deriveStatus(rfqWith({ current_bid_close_at: T('18:10:00') }), T('18:10:01'))).toBe(
      'CLOSED'
    );
  });

  it('is FORCE_CLOSED after close when extensions hit the forced close', () => {
    const rfq = rfqWith({ current_bid_close_at: T('18:30:00') });
    expect(deriveStatus(rfq, T('18:30:00'))).toBe('ACTIVE');
    expect(deriveStatus(rfq, T('18:30:01'))).toBe('FORCE_CLOSED');
  });
});

describe('isInTriggerWindow', () => {
  it('monitors [close - X, close], with the start inclusive', () => {
    expect(isInTriggerWindow(rfqWith(), T('17:49:59'))).toBe(false);
    expect(isInTriggerWindow(rfqWith(), T('17:50:00'))).toBe(true);
    expect(isInTriggerWindow(rfqWith(), T('17:55:00'))).toBe(true);
  });

  it('moves with the current (extended) close time', () => {
    const rfq = rfqWith({ current_bid_close_at: T('18:05:00') });
    expect(isInTriggerWindow(rfq, T('17:54:59'))).toBe(false);
    expect(isInTriggerWindow(rfq, T('17:55:00'))).toBe(true);
  });
});

describe('computeExtension', () => {
  it('adds Y minutes to the current close (6:00 -> 6:05)', () => {
    const ext = computeExtension(rfqWith());
    expect(ext.type).toBe('EXTENDED');
    expect(ext.newClose.toISOString()).toBe('2026-11-01T18:05:00.000Z');
  });

  it('is rolling: extends from the already-extended close', () => {
    const ext = computeExtension(rfqWith({ current_bid_close_at: T('18:05:00') }));
    expect(ext.newClose.toISOString()).toBe('2026-11-01T18:10:00.000Z');
  });

  it('never goes beyond the forced close time', () => {
    const ext = computeExtension(rfqWith({ current_bid_close_at: T('18:28:00') }));
    expect(ext.type).toBe('EXTENDED');
    expect(ext.newClose.toISOString()).toBe('2026-11-01T18:30:00.000Z');
  });

  it('is CAPPED when the close already equals the forced close', () => {
    expect(computeExtension(rfqWith({ current_bid_close_at: T('18:30:00') })).type).toBe('CAPPED');
  });
});

describe('evaluateTrigger', () => {
  const before = rankBids([existing(MAERSK, '800.00', 1), existing(CMA, '900.00', 2)]);

  it('BID_RECEIVED always fires', () => {
    expect(evaluateTrigger('BID_RECEIVED', before, before, 'maersk').fired).toBe(true);
  });

  describe('ANY_RANK_CHANGE', () => {
    it('fires when the order changes', () => {
      const after = rankBids([existing(MAERSK, '800.00', 1), existing(CMA, '700.00', 3)]);
      const result = evaluateTrigger('ANY_RANK_CHANGE', before, after, 'cma');
      expect(result.fired).toBe(true);
      expect(result.reason).toBe('Ranking changed: CMA CGM moved from L2 to L1');
    });

    it('fires when a new supplier enters the ranking, even in last place', () => {
      const after = rankBids([...before, existing(MSC, '1000.00', 3)]);
      const result = evaluateTrigger('ANY_RANK_CHANGE', before, after, 'msc');
      expect(result.fired).toBe(true);
      expect(result.reason).toBe('Ranking changed: MSC entered the ranking at L3');
    });

    it('does not fire when a supplier improves price but keeps the same rank', () => {
      const after = rankBids([existing(MAERSK, '800.00', 1), existing(CMA, '850.00', 3)]);
      expect(evaluateTrigger('ANY_RANK_CHANGE', before, after, 'cma').fired).toBe(false);
    });
  });

  describe('L1_CHANGE', () => {
    it('fires when a different supplier becomes L1', () => {
      const after = rankBids([existing(MAERSK, '800.00', 1), existing(CMA, '799.99', 3)]);
      const result = evaluateTrigger('L1_CHANGE', before, after, 'cma');
      expect(result).toEqual({ fired: true, reason: 'L1 changed from Maersk to CMA CGM' });
    });

    it('does not fire when L1 lowers their own price', () => {
      const after = rankBids([existing(MAERSK, '700.00', 3), existing(CMA, '900.00', 2)]);
      expect(evaluateTrigger('L1_CHANGE', before, after, 'maersk').fired).toBe(false);
    });

    it('does not fire on a rank change below L1', () => {
      const three = rankBids([...before, existing(MSC, '1000.00', 3)]);
      const after = rankBids([...three, existing(MSC, '850.00', 4)]);
      expect(evaluateTrigger('L1_CHANGE', three, after, 'msc').fired).toBe(false);
    });

    it('treats the first-ever bid as an L1 change', () => {
      const after = rankBids([existing(MAERSK, '800.00', 1)]);
      const result = evaluateTrigger('L1_CHANGE', [], after, 'maersk');
      expect(result).toEqual({ fired: true, reason: 'Maersk became the first L1' });
    });
  });
});

describe('evaluateBid', () => {
  const bids = [existing(MAERSK, '800.00', 1), existing(CMA, '900.00', 2)];

  const expectRejected = (fn, status, message) => {
    try {
      fn();
    } catch (err) {
      expect(err).toBeInstanceOf(BidRejectedError);
      expect(err.status).toBe(status);
      expect(err.message).toMatch(message);
      return;
    }
    throw new Error('expected bid to be rejected');
  };

  describe('validity', () => {
    it('rejects bids before the start', () => {
      expectRejected(
        () => evaluateBid({ rfq: rfqWith(), existingBids: [], newBid: quote(MAERSK, '100'), now: T('16:59:59') }),
        409,
        /not started/
      );
    });

    it('rejects bids after the current close even if the forced close has not passed', () => {
      expectRejected(
        () => evaluateBid({ rfq: rfqWith(), existingBids: [], newBid: quote(MAERSK, '100'), now: T('18:00:01') }),
        409,
        /closed/
      );
    });

    it('accepts a bid exactly at the current close', () => {
      const r = evaluateBid({ rfq: rfqWith(), existingBids: [], newBid: quote(MAERSK, '100'), now: T('18:00:00') });
      expect(r.totalCents).toBe(10000);
    });

    it('rejects a bid that is not strictly lower than the supplier\'s previous bid', () => {
      expectRejected(
        () => evaluateBid({ rfq: rfqWith(), existingBids: bids, newBid: quote(MAERSK, '800.00'), now: T('17:30:00') }),
        409,
        /lower than your previous bid/
      );
      expectRejected(
        () => evaluateBid({ rfq: rfqWith(), existingBids: bids, newBid: quote(MAERSK, '500', '200', '100.01'), now: T('17:30:00') }),
        409,
        /lower than your previous bid/
      );
    });

    it('allows a supplier to bid above other suppliers (only their own previous bid matters)', () => {
      const r = evaluateBid({ rfq: rfqWith(), existingBids: bids, newBid: quote(MSC, '5000'), now: T('17:30:00') });
      expect(r.after.find((x) => x.supplier_id === 'msc').rank).toBe(3);
    });

    it('rejects a zero total', () => {
      expectRejected(
        () => evaluateBid({ rfq: rfqWith(), existingBids: [], newBid: quote(MAERSK, '0'), now: T('17:30:00') }),
        400,
        /greater than zero/
      );
    });
  });

  describe('extension decision', () => {
    it('does not extend outside the trigger window', () => {
      const r = evaluateBid({ rfq: rfqWith(), existingBids: bids, newBid: quote(MSC, '100'), now: T('17:49:59') });
      expect(r.extension).toBeNull();
    });

    it('BID_RECEIVED: a bid at 5:55 extends 6:00 -> 6:05 with a reason', () => {
      const r = evaluateBid({ rfq: rfqWith(), existingBids: bids, newBid: quote(MSC, '1000'), now: T('17:55:00') });
      expect(r.extension.type).toBe('EXTENDED');
      expect(r.extension.trigger).toBe('BID_RECEIVED');
      expect(r.extension.oldClose.toISOString()).toBe('2026-11-01T18:00:00.000Z');
      expect(r.extension.newClose.toISOString()).toBe('2026-11-01T18:05:00.000Z');
      expect(r.extension.reason).toBe('Bid received from MSC in the trigger window; extended by 5 min');
    });

    it('ANY_RANK_CHANGE: Supplier B underbids A at 5:58 -> extends', () => {
      const rfq = rfqWith({ extension_trigger: 'ANY_RANK_CHANGE' });
      const r = evaluateBid({ rfq, existingBids: bids, newBid: quote(CMA, '750'), now: T('17:58:00') });
      expect(r.extension.type).toBe('EXTENDED');
      expect(r.extension.reason).toMatch(/CMA CGM moved from L2 to L1/);
    });

    it('ANY_RANK_CHANGE: price improvement without rank change -> no extension', () => {
      const rfq = rfqWith({ extension_trigger: 'ANY_RANK_CHANGE' });
      const r = evaluateBid({ rfq, existingBids: bids, newBid: quote(CMA, '850'), now: T('17:58:00') });
      expect(r.extension).toBeNull();
    });

    it('L1_CHANGE: Supplier C becomes the new lowest at 5:59 -> extends', () => {
      const rfq = rfqWith({ extension_trigger: 'L1_CHANGE' });
      const r = evaluateBid({ rfq, existingBids: bids, newBid: quote(MSC, '700'), now: T('17:59:00') });
      expect(r.extension.type).toBe('EXTENDED');
      expect(r.extension.reason).toMatch(/^L1 changed from Maersk to MSC/);
    });

    it('L1_CHANGE: a new L2 does not extend', () => {
      const rfq = rfqWith({ extension_trigger: 'L1_CHANGE' });
      const r = evaluateBid({ rfq, existingBids: bids, newBid: quote(MSC, '850'), now: T('17:59:00') });
      expect(r.extension).toBeNull();
    });

    it('L1_CHANGE: the first-ever bid in the window extends', () => {
      const rfq = rfqWith({ extension_trigger: 'L1_CHANGE' });
      const r = evaluateBid({ rfq, existingBids: [], newBid: quote(MAERSK, '900'), now: T('17:59:00') });
      expect(r.extension.type).toBe('EXTENDED');
      expect(r.extension.reason).toMatch(/^Maersk became the first L1/);
    });

    it('a partial extension stops exactly at the forced close', () => {
      const rfq = rfqWith({ current_bid_close_at: T('18:28:00') });
      const r = evaluateBid({ rfq, existingBids: bids, newBid: quote(MSC, '100'), now: T('18:27:00') });
      expect(r.extension.newClose.toISOString()).toBe('2026-11-01T18:30:00.000Z');
      expect(r.extension.reason).toMatch(/extended by 2 min \(reached forced close\)$/);
    });

    it('is CAPPED (no extension) when the close already equals the forced close', () => {
      const rfq = rfqWith({ current_bid_close_at: T('18:30:00') });
      const r = evaluateBid({ rfq, existingBids: bids, newBid: quote(MSC, '100'), now: T('18:29:00') });
      expect(r.extension.type).toBe('CAPPED');
      expect(r.extension.newClose).toBeUndefined();
      expect(r.extension.reason).toMatch(/close time already equals forced close$/);
    });

    describe('British Auction disabled (standard RFQ)', () => {
      const standard = (overrides = {}) =>
        rfqWith({
          british_auction_enabled: false,
          trigger_window_minutes: null,
          extension_minutes: null,
          extension_trigger: null,
          ...overrides,
        });

      it('never extends, even for a new L1 seconds before close', () => {
        const r = evaluateBid({ rfq: standard(), existingBids: bids, newBid: quote(MSC, '100'), now: T('17:59:59') });
        expect(r.extension).toBeNull();
        expect(r.after[0].supplier_id).toBe('msc');
      });

      it('never extends on the first-ever bid at the exact close time', () => {
        const r = evaluateBid({ rfq: standard(), existingBids: [], newBid: quote(MAERSK, '100'), now: T('18:00:00') });
        expect(r.extension).toBeNull();
      });

      it('still applies the bid acceptance rules', () => {
        expectRejected(
          () => evaluateBid({ rfq: standard(), existingBids: bids, newBid: quote(MAERSK, '900'), now: T('17:30:00') }),
          409,
          /lower than your previous bid/
        );
        expectRejected(
          () => evaluateBid({ rfq: standard(), existingBids: [], newBid: quote(MAERSK, '100'), now: T('18:00:01') }),
          409,
          /closed/
        );
      });

      it('ends as CLOSED at its fixed close time', () => {
        expect(deriveStatus(standard(), T('18:00:01'))).toBe('CLOSED');
      });
    });

    it('a trigger that does not fire logs nothing, even when capped', () => {
      const rfq = rfqWith({ current_bid_close_at: T('18:30:00'), extension_trigger: 'L1_CHANGE' });
      const r = evaluateBid({ rfq, existingBids: bids, newBid: quote(MSC, '850'), now: T('18:29:00') });
      expect(r.extension).toBeNull();
    });
  });
});
