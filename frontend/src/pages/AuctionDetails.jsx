import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Card, Countdown, ErrorBanner, Field, StatusBadge, buttonClass, inputClass } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import {
  TRIGGER_LABELS,
  deriveStatus,
  formatDate,
  formatDateTime,
  formatMoney,
  formatTime,
  toDateInput,
} from '../lib/format.js';
import { usePolling, useServerNow } from '../lib/hooks.js';

export default function AuctionDetails() {
  const { id } = useParams();
  const { data, error, refresh, offsetMs } = usePolling(() => api.getRfq(id), 3000);
  const nowMs = useServerNow(offsetMs);

  if (!data) {
    return error ? <ErrorBanner message={error} /> : <p className="text-slate-500">Loading…</p>;
  }

  const { rfq, config, ranking, bids, events } = data;
  const status = deriveStatus(rfq, nowMs);
  const money = (v) => formatMoney(v, rfq.currency);

  return (
    <div className="space-y-5">
      <Link to="/" className="text-sm text-indigo-600 hover:underline">
        ← All auctions
      </Link>

      <ErrorBanner message={error} />

      <div className="flex flex-wrap items-start justify-between gap-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold text-slate-900">{rfq.reference}</h1>
            <StatusBadge status={status} />
          </div>
          <p className="text-slate-600">{rfq.name}</p>
          <dl className="mt-3 grid grid-cols-2 gap-x-8 gap-y-1 text-sm sm:grid-cols-4">
            <Info label="Bid start" value={formatDateTime(rfq.bid_start_at)} />
            <Info label="Original close" value={formatDateTime(rfq.original_bid_close_at)} />
            <Info
              label="Current close"
              value={formatDateTime(rfq.current_bid_close_at)}
              highlight={rfq.current_bid_close_at !== rfq.original_bid_close_at}
            />
            <Info label="Forced close" value={formatDateTime(rfq.forced_close_at)} />
            <Info label="Pickup / service date" value={formatDate(rfq.service_date)} />
            <Info label="Currency" value={rfq.currency} />
            <Info label="Lowest bid (L1)" value={ranking[0] ? `${money(ranking[0].total)} · ${ranking[0].carrier_name}` : '—'} />
          </dl>
        </div>
        <div className="min-w-44 text-right">
          <Countdown status={status} startAt={rfq.bid_start_at} closeAt={rfq.current_bid_close_at} nowMs={nowMs} size="lg" />
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Card title="Supplier ranking">
            <RankingTable ranking={ranking} money={money} />
          </Card>

          <Card title={`All bids (${bids.length}), sorted by price`}>
            <BidsTable bids={bids} money={money} />
          </Card>
        </div>

        <div className="space-y-5">
          <Card title="Auction configuration">
            <dl className="space-y-2 text-sm">
              <Info label="Trigger window (X)" value={`${config.trigger_window_minutes} min`} />
              <Info label="Extension duration (Y)" value={`${config.extension_minutes} min`} />
              <Info label="Extension trigger" value={TRIGGER_LABELS[config.extension_trigger]} />
            </dl>
          </Card>

          <BidForm rfq={rfq} status={status} ranking={ranking} onSubmitted={refresh} />
        </div>
      </div>

      <Card title="Activity log">
        <ActivityLog events={events} />
      </Card>
    </div>
  );
}

function Info({ label, value, highlight }) {
  return (
    <div>
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className={highlight ? 'font-medium text-amber-700' : 'font-medium text-slate-800'}>{value}</dd>
    </div>
  );
}

const th = 'px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500';
const td = 'px-3 py-2 whitespace-nowrap';

function RankingTable({ ranking, money }) {
  if (!ranking.length) return <p className="text-sm text-slate-500">No bids yet.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-slate-200 text-sm">
        <thead>
          <tr>
            <th className={th}>Rank</th>
            <th className={th}>Carrier</th>
            <th className={`${th} text-right`}>Freight</th>
            <th className={`${th} text-right`}>Origin</th>
            <th className={`${th} text-right`}>Destination</th>
            <th className={`${th} text-right`}>Total</th>
            <th className={th}>Transit</th>
            <th className={th}>Quote valid until</th>
            <th className={th}>Submitted</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {ranking.map((r) => (
            <tr key={r.id} className={r.rank === 1 ? 'bg-emerald-50/60' : ''}>
              <td className={td}>
                <span
                  className={`inline-flex rounded px-2 py-0.5 text-xs font-bold ${
                    r.rank === 1 ? 'bg-emerald-600 text-white' : 'bg-slate-100 text-slate-700'
                  }`}
                >
                  L{r.rank}
                </span>
              </td>
              <td className={`${td} font-medium`}>{r.carrier_name}</td>
              <td className={`${td} text-right tabular-nums`}>{money(r.freight_charges)}</td>
              <td className={`${td} text-right tabular-nums`}>{money(r.origin_charges)}</td>
              <td className={`${td} text-right tabular-nums`}>{money(r.destination_charges)}</td>
              <td className={`${td} text-right font-semibold tabular-nums`}>{money(r.total)}</td>
              <td className={td}>{r.transit_time_days} days</td>
              <td className={td}>{formatDate(r.quote_valid_until)}</td>
              <td className={`${td} text-slate-500`}>{formatTime(r.created_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-xs text-slate-500">Each supplier's latest bid. Ties go to the earlier submission.</p>
    </div>
  );
}

function BidsTable({ bids, money }) {
  if (!bids.length) return <p className="text-sm text-slate-500">No bids yet.</p>;
  return (
    <div className="max-h-80 overflow-auto">
      <table className="min-w-full divide-y divide-slate-200 text-sm">
        <thead>
          <tr>
            <th className={th}>Carrier</th>
            <th className={`${th} text-right`}>Freight</th>
            <th className={`${th} text-right`}>Origin</th>
            <th className={`${th} text-right`}>Destination</th>
            <th className={`${th} text-right`}>Total</th>
            <th className={th}>Transit</th>
            <th className={th}>Valid until</th>
            <th className={th}>Submitted</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {bids.map((b) => (
            <tr key={b.id}>
              <td className={td}>{b.carrier_name}</td>
              <td className={`${td} text-right tabular-nums`}>{money(b.freight_charges)}</td>
              <td className={`${td} text-right tabular-nums`}>{money(b.origin_charges)}</td>
              <td className={`${td} text-right tabular-nums`}>{money(b.destination_charges)}</td>
              <td className={`${td} text-right font-medium tabular-nums`}>{money(b.total)}</td>
              <td className={td}>{b.transit_time_days} days</td>
              <td className={td}>{formatDate(b.quote_valid_until)}</td>
              <td className={`${td} text-slate-500`}>{formatDateTime(b.created_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const EVENT_STYLES = {
  BID_SUBMITTED: { label: 'Bid', className: 'bg-sky-100 text-sky-800' },
  AUCTION_EXTENDED: { label: 'Extended', className: 'bg-amber-100 text-amber-800' },
  EXTENSION_CAPPED: { label: 'Capped', className: 'bg-rose-100 text-rose-800' },
};

function ActivityLog({ events }) {
  if (!events.length) return <p className="text-sm text-slate-500">No activity yet.</p>;
  return (
    <ol className="space-y-3">
      {[...events].reverse().map((e) => {
        const style = EVENT_STYLES[e.event_type];
        return (
          <li key={e.id} className="flex gap-3 text-sm">
            <span className="w-24 shrink-0 pt-0.5 font-mono text-xs text-slate-500">{formatTime(e.created_at)}</span>
            <span className={`h-fit shrink-0 rounded px-2 py-0.5 text-xs font-semibold ${style.className}`}>{style.label}</span>
            <div>
              <p className="text-slate-800">{e.reason}</p>
              {e.event_type === 'AUCTION_EXTENDED' && (
                <p className="text-xs text-slate-500">
                  Close time {formatTime(e.old_close_at)} → {formatTime(e.new_close_at)} · trigger: {TRIGGER_LABELS[e.trigger_type]}
                </p>
              )}
              {e.event_type === 'EXTENSION_CAPPED' && (
                <p className="text-xs text-slate-500">Close time stays at the forced close: {formatTime(e.old_close_at)}</p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

const MONEY = /^\d{1,10}(\.\d{1,2})?$/;

function BidForm({ rfq, status, ranking, onSubmitted }) {
  const [suppliers, setSuppliers] = useState([]);
  const [form, setForm] = useState({
    supplier_id: '',
    freight_charges: '',
    origin_charges: '',
    destination_charges: '',
    transit_time_days: '',
    quote_valid_until: toDateInput(new Date(Date.now() + 30 * 24 * 3600 * 1000)),
  });
  const [errors, setErrors] = useState([]);
  const [result, setResult] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api.suppliers().then((d) => setSuppliers(d.suppliers)).catch((e) => setErrors([e.message]));
  }, []);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const supplier = suppliers.find((s) => s.id === form.supplier_id);
  const previous = ranking.find((r) => r.supplier_id === form.supplier_id);
  const charges = ['freight_charges', 'origin_charges', 'destination_charges'];
  const total = charges.every((k) => MONEY.test(form[k]))
    ? charges.reduce((sum, k) => sum + Math.round(Number(form[k]) * 100), 0) / 100
    : null;
  const open = status === 'ACTIVE';

  async function onSubmit(e) {
    e.preventDefault();
    const clientErrors = [];
    if (!form.supplier_id) clientErrors.push('Choose who you are bidding as.');
    for (const k of charges) {
      if (!MONEY.test(form[k])) clientErrors.push(`${k.replace('_', ' ')} must be an amount with at most 2 decimals.`);
    }
    if (!/^[1-9]\d*$/.test(form.transit_time_days)) clientErrors.push('Transit time must be a positive whole number of days.');
    if (!form.quote_valid_until) clientErrors.push('Quote validity date is required.');
    setErrors(clientErrors);
    setResult(null);
    if (clientErrors.length) return;

    setSubmitting(true);
    try {
      const res = await api.submitBid(rfq.id, { ...form, transit_time_days: Number(form.transit_time_days) });
      setResult(res);
      setForm((f) => ({ ...f, freight_charges: '', origin_charges: '', destination_charges: '' }));
      onSubmitted();
    } catch (err) {
      setErrors(err.details ?? [err.message]);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card title="Submit a quote">
      {!open && (
        <p className="mb-3 rounded-md bg-slate-100 px-3 py-2 text-sm text-slate-600">
          {status === 'SCHEDULED' ? 'Bidding has not started yet.' : 'Bidding is closed for this RFQ.'}
        </p>
      )}
      <form onSubmit={onSubmit} className="space-y-3" noValidate>
        <fieldset disabled={!open || submitting} className="space-y-3">
          <Field label="Bid as">
            <select className={inputClass} value={form.supplier_id} onChange={set('supplier_id')}>
              <option value="">Select supplier…</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Carrier name">
            <input className={inputClass} value={supplier?.name ?? ''} readOnly placeholder="Filled from supplier" />
          </Field>
          <div className="grid grid-cols-3 gap-2">
            <Field label="Freight">
              <input inputMode="decimal" className={inputClass} value={form.freight_charges} onChange={set('freight_charges')} placeholder="0.00" />
            </Field>
            <Field label="Origin">
              <input inputMode="decimal" className={inputClass} value={form.origin_charges} onChange={set('origin_charges')} placeholder="0.00" />
            </Field>
            <Field label="Destination">
              <input inputMode="decimal" className={inputClass} value={form.destination_charges} onChange={set('destination_charges')} placeholder="0.00" />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Transit time (days)">
              <input type="number" min="1" step="1" className={inputClass} value={form.transit_time_days} onChange={set('transit_time_days')} />
            </Field>
            <Field label="Quote valid until">
              <input type="date" className={inputClass} value={form.quote_valid_until} onChange={set('quote_valid_until')} />
            </Field>
          </div>
          <div className="flex items-center justify-between rounded-md bg-slate-50 px-3 py-2 text-sm">
            <span className="text-slate-600">Total</span>
            <span className="font-semibold tabular-nums">{total == null ? '—' : formatMoney(total, rfq.currency)}</span>
          </div>
          {previous && (
            <p className="text-xs text-slate-500">
              {supplier?.name}'s current bid: {formatMoney(previous.total, rfq.currency)} (L{previous.rank}). A new bid must be lower.
            </p>
          )}
          <button type="submit" className={`${buttonClass} w-full`}>
            {submitting ? 'Submitting…' : 'Submit bid'}
          </button>
        </fieldset>
      </form>

      <div className="mt-3 space-y-2">
        {errors.length > 0 && <ErrorBanner message={errors[0]} details={errors} />}
        {result && (
          <div className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
            <p className="font-medium">
              Bid accepted: {formatMoney(result.bid.total, rfq.currency)}, ranked L{result.bid.rank}.
            </p>
            {result.extension?.type === 'EXTENDED' && (
              <p className="mt-1 text-amber-800">
                Auction extended to {formatTime(result.extension.new_close_at)}: {result.extension.reason}
              </p>
            )}
            {result.extension?.type === 'CAPPED' && (
              <p className="mt-1 text-rose-700">{result.extension.reason}</p>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
