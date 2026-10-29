// The checks engine.
//
// FBR Active Taxpayer status is a REAL check: it looks up the case's CNIC in
// the fbr_atl table, which stands in for the user's actual weekly cron pull
// of FBR's public Active Taxpayer List into a data warehouse. Swap the
// lookup below for a real query against that warehouse and nothing else in
// this file needs to change.
//
// Duplicate check is also real logic (queries this POC's own case table).
//
// NADRA Verisys, AML/PEP/Sanctions, Account-title match and SECP are
// SIMULATED here — those are restricted/paid/manual services with no
// sandbox access from this environment. Each has a clearly commented demo
// trigger so you can show both a pass and a fail path to the client.
// Swapping a simulated check for the real provider means replacing only
// that one function; callers never need to change.

const { db } = require('../db');
const { similarity } = require('./nameMatch');

function checkNameConsistency(caseRow) {
  // REAL logic — compares the name declared at intake (step 1, before the
  // CNIC was even scanned) against the name the CNIC OCR actually read.
  // The capture UI already blocks on this at the time, but this check is
  // the backend's own gate too — in case this endpoint is ever called
  // directly instead of through the UI. A manually confirmed override
  // still routes to the ops queue rather than straight-through: an
  // overridden mismatch is exactly the kind of thing that should get a
  // second set of eyes, not just the field agent's own say-so.
  if (!caseRow.declared_name) {
    return { status: 'Not captured', message: 'No declared name captured at intake to compare against the CNIC.' };
  }
  const score = caseRow.name_match_score;
  if (caseRow.name_override) {
    return { status: 'Override confirmed', message: `Declared name and CNIC name didn’t match (score ${(score ?? 0).toFixed(2)}) — capturer confirmed same person; routed for manual review.` };
  }
  if (score != null && score < 0.6) {
    return { status: 'Mismatch', message: `Declared name "${caseRow.declared_name}" does not match the CNIC name "${caseRow.owner_name}" (score ${score.toFixed(2)}).` };
  }
  return { status: 'Pass', message: 'Declared name matches the name read off the CNIC.' };
}

function checkNadraVerisys(caseRow) {
  // SIMULATED — real NADRA Verisys access requires an institutional
  // agreement via NADRA's Nishan Pakistan portal.
  const cnicOk = /^\d{5}-\d{7}-\d$/.test(caseRow.cnic_number || '');
  if (!cnicOk) {
    return { status: 'Could not verify', message: 'CNIC format did not match NADRA’s record layout.' };
  }
  return { status: 'Pass', message: 'Name, CNIC number and date of birth matched NADRA’s record.' };
}

function checkFbrActiveTaxpayer(caseRow) {
  // REAL logic against sample ATL data (see src/db/index.js).
  const row = db.prepare('SELECT active, snapshot_date FROM fbr_atl WHERE cnic = ?').get(caseRow.cnic_number);
  if (!row) {
    return { status: 'No ATL record', message: 'CNIC not found in the latest ATL snapshot.', reference: 'n/a' };
  }
  return {
    status: row.active ? 'Active' : 'Inactive',
    message: row.active ? 'Found as an active taxpayer in the latest ATL snapshot.' : 'Found but marked inactive in the latest ATL snapshot.',
    reference: `ATL-${row.snapshot_date}`
  };
}

function checkAmlPepSanctions(caseRow) {
  // SIMULATED — demo trigger: any business name containing "chaudhry"
  // (case-insensitive) comes back as a screening hit, so you can show the
  // fail path on demand.
  const hit = (caseRow.business_name || '').toLowerCase().includes('chaudhry');
  if (hit) {
    return { status: 'Hit — needs review', message: 'Name-match hit against the sanctions/PEP watchlist. Needs manual review.' };
  }
  return { status: 'Pass', message: 'No match against AML, PEP or sanctions lists.' };
}

function checkAccountTitleMatch(caseRow) {
  // SIMULATED — fuzzy name match between CNIC holder and the settlement
  // account title. Fails only if the owner name is missing.
  if (!caseRow.owner_name) {
    return { status: 'Could not verify', message: 'No owner name captured to compare against the account title.' };
  }
  return { status: 'Pass', message: 'Account title matches the CNIC holder’s name (fuzzy match, allows for transliteration).' };
}

function checkDuplicate(caseRow) {
  // REAL logic — looks for another non-declined case already on file with
  // the same CNIC.
  const dup = db.prepare(
    "SELECT reference FROM cases WHERE cnic_number = ? AND id != ? AND status != 'declined' LIMIT 1"
  ).get(caseRow.cnic_number, caseRow.id);
  if (dup) {
    return { status: 'Duplicate found', message: `Same CNIC already on an open case (${dup.reference}).` };
  }
  return { status: 'Pass', message: 'No other open case found for this CNIC.' };
}

function checkSecp(caseRow) {
  // SIMULATED — SECP eServices has no public API and its terms prohibit
  // bulk automated lookups, so a real integration would be a manual
  // single-record check by an ops user, not an automated call.
  if (caseRow.tier !== 'Registered') {
    return { status: 'Not required', message: 'SECP registration only applies to the Registered tier.' };
  }
  const trigger = (caseRow.business_name || '').toLowerCase().includes('pending inc');
  if (trigger) {
    return { status: 'Manual review', message: 'Incorporation record not confirmed — needs a manual SECP lookup.' };
  }
  return { status: 'Pass', message: 'Incorporation record confirmed against SECP’s company search.' };
}

const FAIL_STATUSES = new Set(['Hit — needs review', 'Duplicate found', 'Inactive', 'Manual review', 'Could not verify', 'No ATL record', 'Mismatch', 'Override confirmed']);

function runAllChecks(caseRow) {
  const defs = [
    { name: 'Name consistency', mode: 'real', fn: checkNameConsistency },
    { name: 'NADRA Verisys', mode: 'simulated', fn: checkNadraVerisys },
    { name: 'FBR Active Taxpayer', mode: 'real', fn: checkFbrActiveTaxpayer },
    { name: 'AML / PEP / Sanctions', mode: 'simulated', fn: checkAmlPepSanctions },
    { name: 'Account-title match', mode: 'simulated', fn: checkAccountTitleMatch },
    { name: 'Duplicate check', mode: 'real', fn: checkDuplicate },
    { name: 'SECP', mode: 'simulated', fn: checkSecp }
  ];

  const now = new Date().toISOString();
  const insert = db.prepare(
    'INSERT INTO checks (case_id, name, mode, status, message, reference, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );

  const results = defs.map((d) => {
    const r = d.fn(caseRow);
    insert.run(caseRow.id, d.name, d.mode, r.status, r.message, r.reference || null, now);
    return { name: d.name, mode: d.mode, ...r, passed: !FAIL_STATUSES.has(r.status) };
  });

  return results;
}

module.exports = { runAllChecks, FAIL_STATUSES };
