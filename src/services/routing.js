// Routing engine. Mirrors the narrow straight-through activation rule from
// the use-case note: micro tier + existing Allied customer + QR/soundbox
// only + every check passed.

const STP_PRODUCTS = new Set(['Raast QR', 'Soundbox']);
const ALWAYS_REVIEWED = new Set(['Android POS', 'SoftPOS', 'E-commerce gateway']);

function decideRouting(caseRow, checkResults) {
  const products = JSON.parse(caseRow.products || '[]');
  const failed = checkResults.filter((c) => !c.passed);

  if (failed.length > 0) {
    return {
      straightThrough: false,
      riskBand: failed.length > 1 ? 'High risk' : 'Medium risk',
      reason: `${failed[0].name} did not pass (${failed[0].status}) — needs manual review.`
    };
  }

  if (caseRow.tier !== 'Micro') {
    return { straightThrough: false, riskBand: 'Medium risk', reason: 'Tier requires manual review before activation.' };
  }

  if (!caseRow.existing_customer) {
    return { straightThrough: false, riskBand: 'Low risk', reason: 'New-to-bank customer — straight-through rule only covers existing customers.' };
  }

  const reviewedProduct = products.find((p) => ALWAYS_REVIEWED.has(p));
  if (reviewedProduct) {
    return { straightThrough: false, riskBand: 'Medium risk', reason: `${reviewedProduct} always routes to review — not a straight-through product.` };
  }

  const nonStp = products.find((p) => !STP_PRODUCTS.has(p));
  if (nonStp) {
    return { straightThrough: false, riskBand: 'Medium risk', reason: `${nonStp} is not a straight-through product.` };
  }

  if (products.length === 0) {
    return { straightThrough: false, riskBand: 'Low risk', reason: 'No product selected yet.' };
  }

  return { straightThrough: true, riskBand: 'Low risk', reason: null };
}

module.exports = { decideRouting };
