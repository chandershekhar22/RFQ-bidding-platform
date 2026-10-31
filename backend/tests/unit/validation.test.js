import { describe, it, expect } from 'vitest';
import { validateBidInput, validateRfqInput } from '../../src/engine/validation.js';
import { centsToString, isValidMoney, toCents } from '../../src/engine/money.js';

const validRfq = () => ({
  reference: 'RFQ-1001',
  name: 'Mumbai -> Rotterdam FCL',
  currency: 'INR',
  bid_start_at: '2026-11-01T17:00:00Z',
  bid_close_at: '2026-11-01T18:00:00Z',
  forced_close_at: '2026-11-01T18:30:00Z',
  service_date: '2026-11-10',
  trigger_window_minutes: 10,
  extension_minutes: 5,
  extension_trigger: 'L1_CHANGE',
});

describe('validateRfqInput', () => {
  it('accepts a valid RFQ and starts current close at the original close', () => {
    const { errors, value } = validateRfqInput(validRfq());
    expect(errors).toEqual([]);
    expect(value.current_bid_close_at).toEqual(value.original_bid_close_at);
    expect(value.original_bid_close_at.toISOString()).toBe('2026-11-01T18:00:00.000Z');
  });

  it('defaults currency to USD', () => {
    const { value } = validateRfqInput({ ...validRfq(), currency: undefined });
    expect(value.currency).toBe('USD');
  });

  it('rejects an unsupported currency', () => {
    expect(validateRfqInput({ ...validRfq(), currency: 'GBP' }).errors[0]).toMatch(/currency/);
  });

  it('requires forced close later than bid close (equal is rejected)', () => {
    const { errors } = validateRfqInput({ ...validRfq(), forced_close_at: '2026-11-01T18:00:00Z' });
    expect(errors).toContain('Forced bid close time must be later than bid close time.');
  });

  it('requires bid close after bid start', () => {
    const { errors } = validateRfqInput({ ...validRfq(), bid_close_at: '2026-11-01T17:00:00Z' });
    expect(errors).toContain('Bid close time must be after bid start time.');
  });

  it('compares instants, not wall-clock strings, across offsets', () => {
    // 23:00+05:30 is 17:30Z, before the 18:00Z close: valid.
    const { errors } = validateRfqInput({ ...validRfq(), bid_start_at: '2026-11-01T23:00:00+05:30' });
    expect(errors).toEqual([]);
  });

  it('rejects timestamps without a timezone', () => {
    const { errors } = validateRfqInput({ ...validRfq(), bid_start_at: '2026-11-01T17:00:00' });
    expect(errors[0]).toMatch(/bid_start_at/);
  });

  it.each([0, -5, 2.5, '10', null])('rejects X/Y = %s', (bad) => {
    const { errors } = validateRfqInput({ ...validRfq(), trigger_window_minutes: bad, extension_minutes: bad });
    expect(errors).toHaveLength(2);
  });

  it('rejects an unknown trigger and an invalid service date', () => {
    const { errors } = validateRfqInput({ ...validRfq(), extension_trigger: 'ANY', service_date: '2026-02-30' });
    expect(errors).toHaveLength(2);
  });

  it('collects every error at once', () => {
    expect(validateRfqInput({}).errors.length).toBeGreaterThanOrEqual(8);
  });
});

describe('validateBidInput', () => {
  const validBid = () => ({
    supplier_id: '7f1c2a9e-0000-4000-8000-000000000001',
    freight_charges: '1200.50',
    origin_charges: 150,
    destination_charges: '0',
    transit_time_days: 21,
    quote_valid_until: '2026-12-01',
  });

  it('accepts a valid bid and normalises charges to strings', () => {
    const { errors, value } = validateBidInput(validBid());
    expect(errors).toEqual([]);
    expect(value.origin_charges).toBe('150');
  });

  it.each(['-1', '1.234', 'abc', '', null, '12345678901'])('rejects charge %s', (bad) => {
    expect(validateBidInput({ ...validBid(), freight_charges: bad }).errors[0]).toMatch(/freight_charges/);
  });

  it('requires supplier, positive integer transit time and a validity date', () => {
    const { errors } = validateBidInput({
      ...validBid(),
      supplier_id: '',
      transit_time_days: 0,
      quote_valid_until: 'soon',
    });
    expect(errors).toHaveLength(3);
  });
});

describe('money helpers', () => {
  it('round-trips cents without float error', () => {
    expect(toCents('0.1')).toBe(10);
    expect(toCents('19.99')).toBe(1999);
    expect(toCents(7)).toBe(700);
    expect(centsToString(135074)).toBe('1350.74');
    expect(centsToString(5)).toBe('0.05');
  });

  it('accepts numeric(12,2)-compatible values only', () => {
    expect(isValidMoney('9999999999.99')).toBe(true);
    expect(isValidMoney('10000000000')).toBe(false);
    expect(isValidMoney(-1)).toBe(false);
  });
});
