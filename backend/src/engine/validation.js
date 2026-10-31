// Input validation for RFQ creation and bid submission. Pure; returns
// { value, errors } so routes can answer 400 with every problem at once.

import { TRIGGERS } from './auction.js';
import { isValidMoney } from './money.js';

export const CURRENCIES = ['USD', 'INR', 'EUR'];

// Timestamps must carry an explicit UTC offset so they are unambiguous.
const ISO_WITH_TZ = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

const isText = (v, max) => typeof v === 'string' && v.trim() !== '' && v.trim().length <= max;
const isPositiveInt = (v) => Number.isInteger(v) && v > 0;

function parseTimestamp(v) {
  if (typeof v !== 'string' || !ISO_WITH_TZ.test(v)) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function isValidDate(v) {
  if (typeof v !== 'string' || !DATE_ONLY.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(v);
}

export function validateRfqInput(body = {}) {
  const errors = [];

  if (!isText(body.reference, 50)) errors.push('reference is required (max 50 characters).');
  if (!isText(body.name, 200)) errors.push('name is required (max 200 characters).');

  const currency = body.currency ?? 'USD';
  if (!CURRENCIES.includes(currency)) errors.push(`currency must be one of ${CURRENCIES.join(', ')}.`);

  const start = parseTimestamp(body.bid_start_at);
  const close = parseTimestamp(body.bid_close_at);
  const forced = parseTimestamp(body.forced_close_at);
  if (!start) errors.push('bid_start_at must be an ISO 8601 timestamp with timezone.');
  if (!close) errors.push('bid_close_at must be an ISO 8601 timestamp with timezone.');
  if (!forced) errors.push('forced_close_at must be an ISO 8601 timestamp with timezone.');
  if (start && close && start >= close) errors.push('Bid close time must be after bid start time.');
  if (close && forced && close >= forced) {
    errors.push('Forced bid close time must be later than bid close time.');
  }

  if (!isValidDate(body.service_date)) errors.push('service_date must be a date (YYYY-MM-DD).');

  const british = body.british_auction_enabled ?? true;
  if (typeof british !== 'boolean') errors.push('british_auction_enabled must be true or false.');

  // X / Y / trigger only apply to British Auctions; they are ignored (stored NULL) otherwise.
  if (british === true) {
    if (!isPositiveInt(body.trigger_window_minutes)) {
      errors.push('trigger_window_minutes (X) must be a positive integer.');
    }
    if (!isPositiveInt(body.extension_minutes)) {
      errors.push('extension_minutes (Y) must be a positive integer.');
    }
    if (!TRIGGERS.includes(body.extension_trigger)) {
      errors.push(`extension_trigger must be one of ${TRIGGERS.join(', ')}.`);
    }
  }

  if (errors.length) return { errors, value: null };
  return {
    errors,
    value: {
      reference: body.reference.trim(),
      name: body.name.trim(),
      currency,
      bid_start_at: start,
      original_bid_close_at: close,
      current_bid_close_at: close,
      forced_close_at: forced,
      service_date: body.service_date,
      british_auction_enabled: british,
      trigger_window_minutes: british ? body.trigger_window_minutes : null,
      extension_minutes: british ? body.extension_minutes : null,
      extension_trigger: british ? body.extension_trigger : null,
    },
  };
}

export function validateBidInput(body = {}) {
  const errors = [];

  if (!isText(body.supplier_id, 64)) errors.push('supplier_id is required.');
  for (const field of ['freight_charges', 'origin_charges', 'destination_charges']) {
    if (!isValidMoney(body[field])) {
      errors.push(`${field} must be a non-negative amount with at most 2 decimals.`);
    }
  }
  if (!isPositiveInt(body.transit_time_days)) {
    errors.push('transit_time_days must be a positive integer.');
  }
  if (!isValidDate(body.quote_valid_until)) {
    errors.push('quote_valid_until must be a date (YYYY-MM-DD).');
  }

  if (errors.length) return { errors, value: null };
  return {
    errors,
    value: {
      supplier_id: body.supplier_id.trim(),
      freight_charges: String(body.freight_charges).trim(),
      origin_charges: String(body.origin_charges).trim(),
      destination_charges: String(body.destination_charges).trim(),
      transit_time_days: body.transit_time_days,
      quote_valid_until: body.quote_valid_until,
    },
  };
}
