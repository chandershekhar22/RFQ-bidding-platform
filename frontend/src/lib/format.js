// Display helpers. Timestamps arrive as UTC ISO strings and are shown in the
// browser's local time. Money arrives as numeric strings ("1234.50").

export function formatMoney(amount, currency) {
  if (amount == null) return '—';
  return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(Number(amount));
}

export function formatDateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'medium',
  });
}

export function formatTime(iso) {
  return new Date(iso).toLocaleTimeString(undefined, { timeStyle: 'medium' });
}

// 'YYYY-MM-DD' is a calendar date, not an instant: format it without timezone shifts.
export function formatDate(ymd) {
  if (!ymd) return '—';
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { dateStyle: 'medium' });
}

export function formatDuration(ms) {
  if (ms <= 0) return '00:00';
  const total = Math.floor(ms / 1000);
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  if (d > 0) return `${d}d ${pad(h)}h ${pad(m)}m`;
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${pad(m)}:${pad(s)}`;
}

export const TRIGGER_LABELS = {
  BID_RECEIVED: 'Bid received in last X minutes',
  ANY_RANK_CHANGE: 'Any supplier rank change in last X minutes',
  L1_CHANGE: 'Lowest bidder (L1) change in last X minutes',
};

// Mirrors the backend's derived status so the badge flips the moment a countdown ends.
export function deriveStatus(rfq, nowMs) {
  const close = new Date(rfq.current_bid_close_at).getTime();
  if (nowMs < new Date(rfq.bid_start_at).getTime()) return 'SCHEDULED';
  if (nowMs <= close) return 'ACTIVE';
  return close === new Date(rfq.forced_close_at).getTime() ? 'FORCE_CLOSED' : 'CLOSED';
}

// Value for <input type="datetime-local"> in the browser's local time.
export function toLocalInput(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`;
}

export function toDateInput(date) {
  return toLocalInput(date).slice(0, 10);
}
