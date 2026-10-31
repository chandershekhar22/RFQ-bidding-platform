import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, ErrorBanner, Field, buttonClass, inputClass } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { TRIGGER_LABELS, toDateInput, toLocalInput } from '../lib/format.js';

const MIN = 60_000;

function defaults() {
  const now = Date.now();
  return {
    reference: '',
    name: '',
    currency: 'USD',
    bid_start_at: toLocalInput(new Date(now + 5 * MIN)),
    bid_close_at: toLocalInput(new Date(now + 65 * MIN)),
    forced_close_at: toLocalInput(new Date(now + 95 * MIN)),
    service_date: toDateInput(new Date(now + 7 * 24 * 60 * MIN)),
    british_auction_enabled: true,
    trigger_window_minutes: '10',
    extension_minutes: '5',
    extension_trigger: 'BID_RECEIVED',
  };
}

// Client-side checks mirror the server's; the server stays the source of truth.
function validate(f) {
  const errors = [];
  if (!f.reference.trim()) errors.push('RFQ reference ID is required.');
  if (!f.name.trim()) errors.push('RFQ name is required.');
  const start = new Date(f.bid_start_at);
  const close = new Date(f.bid_close_at);
  const forced = new Date(f.forced_close_at);
  if (!f.bid_start_at || !f.bid_close_at || !f.forced_close_at) {
    errors.push('Bid start, bid close and forced close times are required.');
  } else {
    if (start >= close) errors.push('Bid close time must be after bid start time.');
    if (close >= forced) errors.push('Forced bid close time must be later than bid close time.');
  }
  if (!f.service_date) errors.push('Pickup / service date is required.');
  if (f.british_auction_enabled) {
    for (const [key, label] of [
      ['trigger_window_minutes', 'Trigger window (X)'],
      ['extension_minutes', 'Extension duration (Y)'],
    ]) {
      if (!/^[1-9]\d*$/.test(f[key])) errors.push(`${label} must be a positive whole number of minutes.`);
    }
  }
  return errors;
}

export default function CreateRfq() {
  const [form, setForm] = useState(defaults);
  const [errors, setErrors] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const navigate = useNavigate();

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function onSubmit(e) {
    e.preventDefault();
    const clientErrors = validate(form);
    setErrors(clientErrors);
    if (clientErrors.length) return;

    setSubmitting(true);
    const british = form.british_auction_enabled;
    try {
      const { rfq } = await api.createRfq({
        ...form,
        // datetime-local values are local time; send unambiguous UTC instants.
        bid_start_at: new Date(form.bid_start_at).toISOString(),
        bid_close_at: new Date(form.bid_close_at).toISOString(),
        forced_close_at: new Date(form.forced_close_at).toISOString(),
        trigger_window_minutes: british ? Number(form.trigger_window_minutes) : undefined,
        extension_minutes: british ? Number(form.extension_minutes) : undefined,
        extension_trigger: british ? form.extension_trigger : undefined,
      });
      navigate(`/rfqs/${rfq.id}`);
    } catch (err) {
      setErrors(err.details ?? [err.message]);
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="mx-auto max-w-3xl space-y-5" noValidate>
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Create RFQ</h1>
        <p className="text-sm text-slate-500">Times are in your local timezone.</p>
      </div>

      {errors.length > 0 && <ErrorBanner message={errors[0]} details={errors} />}

      <Card title="RFQ details">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="RFQ reference ID">
            <input className={inputClass} value={form.reference} onChange={set('reference')} placeholder="RFQ-2026-010" />
          </Field>
          <Field label="RFQ name">
            <input className={inputClass} value={form.name} onChange={set('name')} placeholder="Mumbai → Hamburg, 2×40ft" />
          </Field>
          <Field label="Currency">
            <select className={inputClass} value={form.currency} onChange={set('currency')}>
              <option value="USD">USD</option>
              <option value="INR">INR</option>
              <option value="EUR">EUR</option>
            </select>
          </Field>
          <Field label="Pickup / service date">
            <input type="date" className={inputClass} value={form.service_date} onChange={set('service_date')} />
          </Field>
        </div>
      </Card>

      <Card title="Bidding schedule">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Bid start">
            <input type="datetime-local" className={inputClass} value={form.bid_start_at} onChange={set('bid_start_at')} />
          </Field>
          <Field label="Bid close">
            <input type="datetime-local" className={inputClass} value={form.bid_close_at} onChange={set('bid_close_at')} />
          </Field>
          <Field label="Forced bid close" hint="Must be later than bid close. The auction never extends past this.">
            <input type="datetime-local" className={inputClass} value={form.forced_close_at} onChange={set('forced_close_at')} />
          </Field>
        </div>
      </Card>

      <Card title="British Auction">
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            checked={form.british_auction_enabled}
            onChange={(e) => setForm((f) => ({ ...f, british_auction_enabled: e.target.checked }))}
            className="mt-0.5 h-4 w-4 rounded border-slate-300 text-indigo-600"
          />
          <span>
            <span className="block text-sm font-medium text-slate-800">Enable British Auction</span>
            <span className="block text-xs text-slate-500">
              {form.british_auction_enabled
                ? 'Bidding activity near the close extends the auction, up to the forced close time.'
                : 'Standard RFQ: the bid close time is fixed and is never extended.'}
            </span>
          </span>
        </label>
      </Card>

      {form.british_auction_enabled && (
        <Card title="British Auction configuration">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Trigger window (X minutes)" hint="Monitor bidding activity in the last X minutes before close.">
              <input type="number" min="1" step="1" className={inputClass} value={form.trigger_window_minutes} onChange={set('trigger_window_minutes')} />
            </Field>
            <Field label="Extension duration (Y minutes)" hint="Minutes added to the close time when triggered.">
              <input type="number" min="1" step="1" className={inputClass} value={form.extension_minutes} onChange={set('extension_minutes')} />
            </Field>
          </div>
          <fieldset className="mt-4">
            <legend className="text-sm font-medium text-slate-700">Extension trigger</legend>
            <div className="mt-2 space-y-2">
              {Object.entries(TRIGGER_LABELS).map(([value, label]) => (
                <label key={value} className="flex items-center gap-2 text-sm text-slate-700">
                  <input
                    type="radio"
                    name="extension_trigger"
                    value={value}
                    checked={form.extension_trigger === value}
                    onChange={set('extension_trigger')}
                    className="text-indigo-600"
                  />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>
        </Card>
      )}

      <div className="flex justify-end gap-3">
        <button type="button" onClick={() => navigate('/')} className="rounded-md px-4 py-2 text-sm font-medium text-slate-600 hover:text-slate-900">
          Cancel
        </button>
        <button type="submit" disabled={submitting} className={buttonClass}>
          {submitting ? 'Creating…' : 'Create RFQ'}
        </button>
      </div>
    </form>
  );
}
