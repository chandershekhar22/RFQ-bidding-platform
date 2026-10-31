import { Link, useNavigate } from 'react-router-dom';
import { Countdown, ErrorBanner, StatusBadge, buttonClass } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { deriveStatus, formatDateTime, formatMoney } from '../lib/format.js';
import { usePolling, useServerNow } from '../lib/hooks.js';

export default function AuctionList() {
  const { data, error, offsetMs } = usePolling(api.listRfqs, 5000);
  const nowMs = useServerNow(offsetMs);
  const navigate = useNavigate();

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">British Auctions</h1>
          <p className="text-sm text-slate-500">All RFQs. Times are in your local timezone.</p>
        </div>
        <Link to="/rfqs/new" className={buttonClass}>
          + New RFQ
        </Link>
      </div>

      <ErrorBanner message={error} />

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3">RFQ</th>
              <th className="px-4 py-3 text-right">Current lowest bid</th>
              <th className="px-4 py-3">Current bid close</th>
              <th className="px-4 py-3">Forced close</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Time left</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {!data && !error && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-slate-500">
                  Loading…
                </td>
              </tr>
            )}
            {data?.rfqs.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-slate-500">
                  No RFQs yet. Create one to start an auction.
                </td>
              </tr>
            )}
            {data?.rfqs.map((rfq) => {
              const status = deriveStatus(rfq, nowMs);
              const extended = rfq.current_bid_close_at !== rfq.original_bid_close_at;
              return (
                <tr
                  key={rfq.id}
                  onClick={() => navigate(`/rfqs/${rfq.id}`)}
                  className="cursor-pointer hover:bg-slate-50"
                >
                  <td className="px-4 py-3">
                    <Link to={`/rfqs/${rfq.id}`} className="font-medium text-indigo-600 hover:underline">
                      {rfq.reference}
                    </Link>
                    <div className="text-slate-600">{rfq.name}</div>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="font-semibold tabular-nums">{formatMoney(rfq.lowest_bid, rfq.currency)}</div>
                    <div className="text-xs text-slate-500">
                      {rfq.bid_count} bid{rfq.bid_count === 1 ? '' : 's'}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div>{formatDateTime(rfq.current_bid_close_at)}</div>
                    {extended && <div className="text-xs text-amber-700">extended</div>}
                  </td>
                  <td className="px-4 py-3">{formatDateTime(rfq.forced_close_at)}</td>
                  <td className="px-4 py-3">
                    <StatusBadge status={status} />
                  </td>
                  <td className="px-4 py-3">
                    <Countdown
                      status={status}
                      startAt={rfq.bid_start_at}
                      closeAt={rfq.current_bid_close_at}
                      nowMs={nowMs}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
