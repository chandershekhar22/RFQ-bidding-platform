import { Link, NavLink, Route, Routes } from 'react-router-dom';
import AuctionList from './pages/AuctionList.jsx';
import AuctionDetails from './pages/AuctionDetails.jsx';
import CreateRfq from './pages/CreateRfq.jsx';

const navClass = ({ isActive }) =>
  `rounded-md px-3 py-1.5 text-sm font-medium ${
    isActive ? 'bg-slate-100 text-slate-900' : 'text-slate-600 hover:text-slate-900'
  }`;

export default function App() {
  return (
    <div className="min-h-screen">
      <nav className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <Link to="/" className="text-base font-semibold text-slate-900">
            RFQ <span className="text-indigo-600">British Auction</span>
          </Link>
          <div className="flex gap-1">
            <NavLink to="/" end className={navClass}>
              Auctions
            </NavLink>
            <NavLink to="/rfqs/new" className={navClass}>
              New RFQ
            </NavLink>
          </div>
        </div>
      </nav>
      <main className="mx-auto max-w-6xl px-4 py-6">
        <Routes>
          <Route path="/" element={<AuctionList />} />
          <Route path="/rfqs/new" element={<CreateRfq />} />
          <Route path="/rfqs/:id" element={<AuctionDetails />} />
          <Route path="*" element={<p className="text-slate-600">Page not found.</p>} />
        </Routes>
      </main>
    </div>
  );
}
