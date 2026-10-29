const express = require('express');
const { db } = require('../db');

const router = express.Router();

// Ops queue listing — cases waiting on a maker-checker decision.
router.get('/', (req, res) => {
  const rows = db.prepare(
    "SELECT id, reference, channel, tier, owner_name, business_name, products, risk_band, queue_reason, status, created_at FROM cases WHERE status = 'queued' ORDER BY created_at DESC"
  ).all();
  res.json(rows.map((r) => ({ ...r, products: JSON.parse(r.products || '[]') })));
});

module.exports = router;
