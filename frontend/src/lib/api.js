const BASE = import.meta.env.VITE_API_BASE_URL;

async function request(method, path, body) {
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error(
      `Cannot reach the API at ${BASE}. Check that the backend is running and that ` +
        `CORS_ORIGIN in backend/.env matches this page (${window.location.origin}).`
    );
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.details = data.details;
    throw err;
  }
  return data;
}

export const api = {
  suppliers: () => request('GET', '/suppliers'),
  listRfqs: () => request('GET', '/rfqs'),
  getRfq: (id) => request('GET', `/rfqs/${id}`),
  createRfq: (body) => request('POST', '/rfqs', body),
  submitBid: (id, body) => request('POST', `/rfqs/${id}/bids`, body),
};
