// Money is handled as integer cents inside the engine so comparisons are exact.
// Postgres numeric(12,2) arrives from `pg` as a string like "1234.50".

const MONEY_PATTERN = /^\d{1,10}(\.\d{1,2})?$/; // fits numeric(12,2)

export function isValidMoney(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return false;
  return MONEY_PATTERN.test(String(value).trim());
}

export function toCents(value) {
  const [whole, frac = ''] = String(value).trim().split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}

export function centsToString(cents) {
  const whole = Math.floor(cents / 100);
  const frac = String(cents % 100).padStart(2, '0');
  return `${whole}.${frac}`;
}
