import cors from 'cors';
import express from 'express';
import { BidRejectedError } from './engine/auction.js';
import { validateBidInput, validateRfqInput } from './engine/validation.js';
import { HttpError } from './errors.js';
import * as auction from './services/auctionService.js';

// Express 4 does not catch rejected promises from async handlers.
const route = (handler) => (req, res, next) => Promise.resolve(handler(req, res)).catch(next);

export function createApp(pool, { corsOrigin } = {}) {
  const app = express();
  app.use(cors(corsOrigin ? { origin: corsOrigin.split(',').map((o) => o.trim()) } : {}));
  app.use(express.json({ limit: '100kb' }));

  app.get('/api/health', (req, res) => res.json({ ok: true }));

  app.get('/api/suppliers', route(async (req, res) => {
    res.json(await auction.listSuppliers(pool));
  }));

  app.get('/api/rfqs', route(async (req, res) => {
    res.json(await auction.listRfqs(pool));
  }));

  app.post('/api/rfqs', route(async (req, res) => {
    const { errors, value } = validateRfqInput(req.body);
    if (errors.length) throw new HttpError(400, errors[0], errors);
    res.status(201).json(await auction.createRfq(pool, value));
  }));

  app.get('/api/rfqs/:id', route(async (req, res) => {
    res.json(await auction.getRfqDetails(pool, req.params.id));
  }));

  app.post('/api/rfqs/:id/bids', route(async (req, res) => {
    const { errors, value } = validateBidInput(req.body);
    if (errors.length) throw new HttpError(400, errors[0], errors);
    res.status(201).json(await auction.submitBid(pool, req.params.id, value));
  }));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError || err instanceof BidRejectedError) {
      return res.status(err.status).json({ error: err.message, details: err.details });
    }
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'Request body must be valid JSON.' });
    }
    console.error(err);
    res.status(500).json({ error: 'Internal server error.' });
  });

  return app;
}
