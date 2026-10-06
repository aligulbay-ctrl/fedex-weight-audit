const LB_TO_KG = 0.45359237;

// Turkish-formatted numbers use "." as thousands separator and "," as decimal
// separator (e.g. "1.385,58" -> 1385.58, "27,1" -> 27.1).
export function parseTrNumber(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const cleaned = s.replace(/\./g, "").replace(",", ".");
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

// Normalizes any of the unit spellings FedEx invoices/APIs actually use
// (KG, KGS, kg., Kg, LB, LBS, Lb. ...) down to a canonical "KG" or "LB".
// Returns null for anything unrecognized rather than guessing - callers
// should treat null as "weight unit unknown", never assume KG.
export function normalizeWeightUnit(unit) {
  const u = String(unit || "").trim().toUpperCase().replace(/\.$/, "");
  if (u === "KG" || u === "KGS") return "KG";
  if (u === "LB" || u === "LBS") return "LB";
  return null;
}

export function toKg(value, unit) {
  if (value == null || !Number.isFinite(value)) return null;
  const u = normalizeWeightUnit(unit);
  if (u === "KG") return value;
  if (u === "LB") return value * LB_TO_KG;
  return null;
}

export function toLb(kg) {
  if (kg == null || !Number.isFinite(kg)) return null;
  return kg / LB_TO_KG;
}

/**
 * Compares the invoiced weight (already normalized to kg) against the
 * actual weight FedEx reports for the shipment, and decides whether the
 * gap is large enough to flag for review.
 *
 * thresholdKg / thresholdPct: an absolute floor (kg) AND a relative floor
 * (%) both have to be cleared for a shipment to be flagged, so tiny
 * rounding differences on small packages don't create noise.
 */
export function evaluateDiscrepancy(invoicedKg, actualKg, thresholdKg = 0.5, thresholdPct = 5) {
  // Number.isFinite (not `== null`) so this also catches NaN, not just
  // null/undefined - callers sometimes do `parseFloat(possiblyNullValue)`,
  // and parseFloat(null) is NaN, which `== null` does NOT match. Postgres's
  // NUMERIC type happily stores a literal 'NaN', so letting one slip past
  // here means it gets written to weight_diff_kg/weight_diff_pct and then
  // rendered as the literal string "NaN kg (NaN%)" on the dashboard forever
  // (a real bug seen in production - see README).
  if (!Number.isFinite(invoicedKg) || !Number.isFinite(actualKg)) {
    return { diffKg: null, diffPct: null, isDiscrepancy: null };
  }
  const diffKg = round(invoicedKg - actualKg, 3);
  const diffPct = actualKg > 0 ? round((diffKg / actualKg) * 100, 2) : null;
  const isDiscrepancy =
    Math.abs(diffKg) >= thresholdKg && (diffPct == null || Math.abs(diffPct) >= thresholdPct);
  return { diffKg, diffPct, isDiscrepancy };
}

function round(n, digits) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

// Shared "match the invoice's own unit" display helpers - used by the
// dashboard (app/page.js) AND every export/report format (CSV already
// carries raw kg for downstream processing, so these are for the
// human-facing xlsx/PDF reports and the dashboard table only). A row
// invoiced in LB shows the FedEx/actual weight converted to LB, with the kg
// figure alongside for reference; a row invoiced in KG (or with an
// unrecognized unit) just shows kg - never guessing a unit we don't have.
export function formatWeightInInvoiceUnit(actualWeightKg, invoicedUnit) {
  if (actualWeightKg == null) return "—";
  const kg = Number(actualWeightKg);
  if (invoicedUnit === "LB") {
    return `${toLb(kg).toFixed(2)} LB (${kg.toFixed(2)} kg)`;
  }
  return `${kg.toFixed(2)} kg`;
}

// Same unit-matching idea for the difference column - toLb() is a linear
// conversion, so converting the already-computed kg difference is exactly
// equivalent to differencing the two native-unit values directly.
export function formatDiffInInvoiceUnit(diffKg, invoicedUnit) {
  if (diffKg == null) return "—";
  const diff = Number(diffKg);
  if (invoicedUnit === "LB") {
    const diffLb = toLb(diff);
    return `${diffLb > 0 ? "+" : ""}${diffLb.toFixed(2)} LB`;
  }
  return `${diff > 0 ? "+" : ""}${diff.toFixed(2)} kg`;
}
