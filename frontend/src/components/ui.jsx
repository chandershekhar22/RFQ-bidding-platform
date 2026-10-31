import { useRef } from 'react';
import { useFlashOnChange } from '../lib/hooks.js';
import { formatDuration, formatTime } from '../lib/format.js';

const STATUS_STYLES = {
  SCHEDULED: 'bg-sky-50 text-sky-700 ring-sky-600/20',
  ACTIVE: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  CLOSED: 'bg-slate-100 text-slate-600 ring-slate-500/20',
  FORCE_CLOSED: 'bg-rose-50 text-rose-700 ring-rose-600/20',
};
const STATUS_LABELS = {
  SCHEDULED: 'Scheduled',
  ACTIVE: 'Active',
  CLOSED: 'Closed',
  FORCE_CLOSED: 'Force Closed',
};

export function StatusBadge({ status }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${STATUS_STYLES[status]}`}
    >
      {status === 'ACTIVE' && <span className="mr-1.5 h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />}
      {STATUS_LABELS[status]}
    </span>
  );
}

/** Marks an RFQ with British Auction turned off (fixed close time). */
export function StandardBadge() {
  return (
    <span className="ml-2 inline-flex rounded px-1.5 py-0.5 align-middle text-[10px] font-semibold uppercase tracking-wide text-slate-600 ring-1 ring-inset ring-slate-300">
      Standard RFQ
    </span>
  );
}

/**
 * Time left until the auction closes (or starts). Flashes and shows the
 * extension when `closeAt` moves forward between polls.
 */
export function Countdown({ status, startAt, closeAt, nowMs, size = 'sm' }) {
  const flash = useFlashOnChange(closeAt, 4000);
  const previousClose = useRef(closeAt);
  const extendedFrom = useRef(null);
  if (previousClose.current !== closeAt) {
    extendedFrom.current = previousClose.current;
    previousClose.current = closeAt;
  }

  const big = size === 'lg';
  if (status === 'CLOSED' || status === 'FORCE_CLOSED') {
    return <span className={`${big ? 'text-2xl' : 'text-sm'} font-medium text-slate-400`}>Ended</span>;
  }

  const target = status === 'SCHEDULED' ? startAt : closeAt;
  const remaining = new Date(target).getTime() - nowMs;
  const urgent = status === 'ACTIVE' && remaining < 60_000;

  return (
    <span className="inline-flex flex-col">
      <span className={big ? 'text-xs uppercase tracking-wide text-slate-500' : 'text-xs text-slate-500'}>
        {status === 'SCHEDULED' ? 'Starts in' : 'Closes in'}
      </span>
      <span
        className={[
          'rounded px-1 font-mono tabular-nums transition-colors duration-700',
          big ? 'text-3xl font-semibold' : 'text-sm font-medium',
          flash ? 'bg-amber-200 text-amber-900' : urgent ? 'text-rose-600' : 'text-slate-900',
        ].join(' ')}
      >
        {formatDuration(remaining)}
      </span>
      {flash && extendedFrom.current && (
        <span className="mt-1 text-xs font-semibold text-amber-700">
          ⏱ Extended: {formatTime(extendedFrom.current)} → {formatTime(closeAt)}
        </span>
      )}
    </span>
  );
}

export function Card({ title, actions, children, className = '' }) {
  return (
    <section className={`rounded-xl border border-slate-200 bg-white shadow-sm ${className}`}>
      {(title || actions) && (
        <header className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
          <h2 className="text-sm font-semibold text-slate-800">{title}</h2>
          {actions}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

export function Field({ label, hint, children }) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-slate-700">{label}</span>
      <div className="mt-1">{children}</div>
      {hint && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
    </label>
  );
}

export const inputClass =
  'block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm ' +
  'focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 ' +
  'read-only:bg-slate-100 read-only:text-slate-600 disabled:bg-slate-100';

export const buttonClass =
  'inline-flex items-center justify-center rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium ' +
  'text-white shadow-sm hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50';

export function ErrorBanner({ message, details }) {
  if (!message) return null;
  const extra = (details ?? []).filter((d) => d !== message);
  return (
    <div className="rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
      <p className="font-medium">{message}</p>
      {extra.length > 0 && (
        <ul className="mt-1 list-disc pl-5">
          {extra.map((d) => (
            <li key={d}>{d}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
