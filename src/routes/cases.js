const express = require('express');
const crypto = require('crypto');
const { db } = require('../db');
const { scanCnic } = require('../services/cnicOcr');
const { runAllChecks } = require('../services/checks');
const { decideRouting } = require('../services/routing');
const { similarity } = require('../services/nameMatch');

const router = express.Router();

function nowIso() { return new Date().toISOString(); }

function makeReference() {
  const d = new Date();
  const ymd = d.toISOString().slice(2, 10).replace(/-/g, '');
  const rand = Math.floor(100000 + Math.random() * 900000);
  return `MO-${ymd}-${rand}`;
}

function getCaseOr404(req, res) {
  const row = db.prepare('SELECT * FROM cases WHERE id = ?').get(req.params.id);
  if (!row) {
    res.status(404).json({ error: 'Case not found.' });
    return null;
  }
  return row;
}

function serializeCase(row) {
  return { ...row, products: JSON.parse(row.products || '[]') };
}

function touch(id) {
  db.prepare('UPDATE cases SET updated_at = ? WHERE id = ?').run(nowIso(), id);
}

// Create a new case for a given channel.
router.post('/', (req, res) => {
  const { channel } = req.body || {};
  if (!['self-service', 'field-agent', 'branch'].includes(channel)) {
    return res.status(400).json({ error: 'channel must be one of self-service, field-agent, branch.' });
  }
  const id = crypto.randomUUID();
  const reference = makeReference();
  const ts = nowIso();
  db.prepare(
    `INSERT INTO cases (id, reference, channel, tier, existing_customer, status, created_at, updated_at)
     VALUES (?, ?, ?, 'Micro', 1, 'draft', ?, ?)`
  ).run(id, reference, channel, ts, ts);
  const row = db.prepare('SELECT * FROM cases WHERE id = ?').get(id);
  res.status(201).json(serializeCase(row));
});

router.get('/:id', (req, res) => {
  const row = getCaseOr404(req, res);
  if (!row) return;
  const checks = db.prepare('SELECT name, mode, status, message, reference, created_at FROM checks WHERE case_id = ? ORDER BY id').all(row.id);
  res.json({ ...serializeCase(row), checks });
});

// Step 1 — who. "owner_name" here is the DECLARED name — what the person
// doing capture typed in, before the CNIC is even scanned. It's kept
// separate from the CNIC's own name so the two can be compared.
router.patch('/:id/who', (req, res) => {
  const row = getCaseOr404(req, res);
  if (!row) return;
  const { owner_name, phone } = req.body || {};
  const declaredName = owner_name ?? row.declared_name;
  db.prepare('UPDATE cases SET declared_name = ?, phone = ? WHERE id = ?').run(declaredName, phone ?? row.phone, row.id);

  // If the CNIC was already scanned (e.g. the capturer went back to fix a
  // mismatched name), recompute the match against the new declared name
  // rather than leaving a stale comparison in place.
  if (row.cnic_scanned) {
    const score = similarity(declaredName, row.owner_name);
    db.prepare('UPDATE cases SET name_match_score = ?, name_override = 0 WHERE id = ?').run(score, row.id);
  }

  touch(row.id);
  res.json(serializeCase(db.prepare('SELECT * FROM cases WHERE id = ?').get(row.id)));
});

// Step 2 — identity / CNIC scan. Calls out to AWS Bedrock (see
// src/services/cnicOcr.js) with the uploaded front/back images; falls back
// to a sample reading if that call fails or no image was sent.
//
// The name read off the CNIC becomes the case's authoritative owner_name —
// but first it's fuzzy-compared against what was declared in step 1. A
// mismatch is surfaced to the caller (and the UI blocks on it) rather than
// silently overwritten.
router.post('/:id/cnic-scan', async (req, res) => {
  const row = getCaseOr404(req, res);
  if (!row) return;
  const { frontBase64, backBase64, format } = req.body || {};
  let extracted;
  try {
    extracted = await scanCnic({ frontBase64, backBase64, format });
  } catch (err) {
    return res.status(502).json({ error: `CNIC extraction failed: ${err.message}` });
  }

  const score = similarity(row.declared_name, extracted.owner_name);
  const nameMismatch = score !== null && score < 0.6;

  db.prepare(
    `UPDATE cases SET owner_name = ?, cnic_number = ?, cnic_dob = ?, cnic_father_name = ?,
     cnic_address = ?, cnic_address_confidence = ?, cnic_scanned = 1, name_match_score = ?,
     name_override = 0 WHERE id = ?`
  ).run(
    extracted.owner_name, extracted.cnic_number, extracted.cnic_dob, extracted.cnic_father_name,
    extracted.cnic_address, extracted.cnic_address_confidence, score, row.id
  );
  touch(row.id);
  res.json({
    ...serializeCase(db.prepare('SELECT * FROM cases WHERE id = ?').get(row.id)),
    ocrSource: extracted._source || 'stub',
    ocrError: extracted._error || null,
    nameMismatch,
    nameMatchScore: score
  });
});

// Explicit override when a capture-time name mismatch is a false alarm
// (e.g. the declared name was a nickname or informal spelling). This is
// logged on the case and still feeds the Name consistency check below as
// "resolved", rather than erasing the fact that it happened.
router.post('/:id/confirm-name-override', (req, res) => {
  const row = getCaseOr404(req, res);
  if (!row) return;
  db.prepare('UPDATE cases SET name_override = 1 WHERE id = ?').run(row.id);
  touch(row.id);
  res.json(serializeCase(db.prepare('SELECT * FROM cases WHERE id = ?').get(row.id)));
});

// Step 3 — business & outlet
router.patch('/:id/business', (req, res) => {
  const row = getCaseOr404(req, res);
  if (!row) return;
  const { business_name, business_address, category, gps_lat, gps_lng, shop_photo } = req.body || {};
  db.prepare(
    `UPDATE cases SET business_name = ?, business_address = ?, category = ?, gps_lat = ?, gps_lng = ?, shop_photo = ? WHERE id = ?`
  ).run(
    business_name ?? row.business_name,
    business_address ?? row.business_address,
    category ?? row.category,
    gps_lat ?? row.gps_lat,
    gps_lng ?? row.gps_lng,
    shop_photo != null ? (shop_photo ? 1 : 0) : row.shop_photo,
    row.id
  );
  touch(row.id);
  res.json(serializeCase(db.prepare('SELECT * FROM cases WHERE id = ?').get(row.id)));
});

// Step 4 — products (also returns a live eligibility preview, before checks run)
router.patch('/:id/products', (req, res) => {
  const row = getCaseOr404(req, res);
  if (!row) return;
  const { products } = req.body || {};
  if (!Array.isArray(products)) return res.status(400).json({ error: 'products must be an array.' });
  db.prepare('UPDATE cases SET products = ? WHERE id = ?').run(JSON.stringify(products), row.id);
  touch(row.id);
  const updated = db.prepare('SELECT * FROM cases WHERE id = ?').get(row.id);
  const preview = decideRouting(updated, []); // no checks run yet — assumes they will pass
  res.json({ ...serializeCase(updated), eligibilityPreview: preview });
});

// Step 5 — submit
router.post('/:id/submit', (req, res) => {
  const row = getCaseOr404(req, res);
  if (!row) return;
  db.prepare("UPDATE cases SET status = 'submitted' WHERE id = ?").run(row.id);
  touch(row.id);
  res.json(serializeCase(db.prepare('SELECT * FROM cases WHERE id = ?').get(row.id)));
});

// Run the 6 checks and route the case.
router.post('/:id/run-checks', (req, res) => {
  const row = getCaseOr404(req, res);
  if (!row) return;
  const results = runAllChecks(row);
  const routing = decideRouting(row, results);
  const newStatus = routing.straightThrough ? 'activated' : 'queued';
  db.prepare(
    'UPDATE cases SET status = ?, risk_band = ?, queue_reason = ? WHERE id = ?'
  ).run(newStatus, routing.riskBand, routing.reason, row.id);
  touch(row.id);
  res.json({ checks: results, routing, case: serializeCase(db.prepare('SELECT * FROM cases WHERE id = ?').get(row.id)) });
});

// Maker-checker decision from the ops queue.
router.post('/:id/decision', (req, res) => {
  const row = getCaseOr404(req, res);
  if (!row) return;
  const { decision, note, decidedBy } = req.body || {};
  const map = { approve: 'approved', approve_limits: 'approved_limits', query: 'queried', decline: 'declined' };
  if (!map[decision]) return res.status(400).json({ error: 'decision must be one of approve, approve_limits, query, decline.' });
  db.prepare('UPDATE cases SET status = ?, decision_note = ?, decided_by = ? WHERE id = ?')
    .run(map[decision], note || null, decidedBy || 'Ops reviewer', row.id);
  touch(row.id);
  res.json(serializeCase(db.prepare('SELECT * FROM cases WHERE id = ?').get(row.id)));
});

// Merchant-facing tracking — status and a plain-language reason only, never
// the internal risk score or check detail.
router.get('/:id/tracking', (req, res) => {
  const row = getCaseOr404(req, res);
  if (!row) return;
  const checksRun = db.prepare('SELECT COUNT(*) AS n FROM checks WHERE case_id = ?').get(row.id).n > 0;
  const activeStates = ['activated', 'approved', 'approved_limits'];
  const messages = {
    draft: 'Your application hasn’t been submitted yet.',
    submitted: 'We’ve received your application and are running checks.',
    queued: 'Your application is under review.',
    approved: 'Your account is active.',
    approved_limits: 'Your account is active, with limits while we complete a few more checks.',
    activated: 'Your account is active.',
    queried: 'We need a bit more information from you — your branch or agent will be in touch.',
    declined: 'We’re unable to proceed with this application right now.'
  };
  res.json({
    reference: row.reference,
    business_name: row.business_name,
    status: row.status,
    message: messages[row.status] || 'Your application is being processed.',
    steps: [
      { title: 'Submitted', done: row.status !== 'draft' },
      { title: 'Checks complete', done: checksRun },
      { title: 'Activated', done: activeStates.includes(row.status) },
      { title: 'Device confirmed', done: false }
    ]
  });
});

module.exports = router;
