// Simple, explainable fuzzy name matching — good enough to flag a plainly
// different person or a typo, not a production transliteration-aware
// matcher. Swap this file for something more sophisticated if this heads
// toward real use (Urdu-to-English transliteration has far more variance
// than Levenshtein distance alone captures).

function normalize(name) {
  return (name || '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const row = new Array(n + 1);
  for (let j = 0; j <= n; j++) row[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = row[j];
      row[j] = a[i - 1] === b[j - 1]
        ? prev
        : 1 + Math.min(prev, row[j], row[j - 1]);
      prev = temp;
    }
  }
  return row[n];
}

function levenshteinRatio(a, b) {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  const dist = levenshtein(a, b);
  return 1 - dist / Math.max(a.length, b.length);
}

function tokenOverlapRatio(a, b) {
  const ta = new Set(a.split(' ').filter(Boolean));
  const tb = new Set(b.split(' ').filter(Boolean));
  if (ta.size === 0 && tb.size === 0) return 1;
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  // Against the smaller set, so a shortened/partial name ("Imran Tariq")
  // still scores well against the fuller CNIC name ("Muhammad Imran Tariq").
  return shared / Math.min(ta.size, tb.size);
}

// Returns a 0..1 similarity score — the higher of a whole-string edit-
// distance ratio and a token-overlap ratio, so both "one typo'd letter"
// and "same words, different order / a nickname dropped" score well.
function similarity(nameA, nameB) {
  const a = normalize(nameA);
  const b = normalize(nameB);
  if (!a || !b) return null; // nothing to compare
  return Math.max(levenshteinRatio(a, b), tokenOverlapRatio(a, b));
}

const MATCH_THRESHOLD = 0.6;

function isMatch(nameA, nameB) {
  const score = similarity(nameA, nameB);
  return score === null ? true : score >= MATCH_THRESHOLD; // nothing to compare => don't block
}

module.exports = { similarity, isMatch, MATCH_THRESHOLD };
