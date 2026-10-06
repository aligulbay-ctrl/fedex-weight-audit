// Shared data-fetch + summary logic for every "discrepancy report" output
// format (CSV, Excel, PDF) so they never drift from each other - all three
// pull the exact same rows with the exact same query and the exact same
// summary math.
import { queryDb } from "./db.js";
import { disputeStatusLabel } from "./statusLabels.js";

// `only`: "discrepancy" (default) = only rows flagged is_discrepancy,
// "all" = every shipment, "fedex_eligible" / "below_threshold" / "negative"
// = the same three-way fark(kg) split used by the dashboard's filters (see
// app/api/shipments/route.js for the shared reasoning) - "fedex_eligible"
// needs fedexMinDisputeKg (from lib/settings.js) passed in since it's the
// configurable threshold, not a fixed value.
export async function getReportRows(only = "discrepancy", { fedexMinDisputeKg } = {}) {
  let clause = "WHERE s.is_discrepancy IS TRUE";
  const params = [];
  if (only === "all") {
    clause = "";
  } else if (only === "fedex_eligible") {
    params.push(fedexMinDisputeKg);
    clause = `WHERE s.is_discrepancy IS TRUE AND s.weight_diff_kg >= $${params.length}`;
  } else if (only === "below_threshold") {
    params.push(fedexMinDisputeKg);
    clause = `WHERE s.is_discrepancy IS TRUE AND s.weight_diff_kg >= 0 AND s.weight_diff_kg < $${params.length}`;
  } else if (only === "negative") {
    clause = "WHERE s.is_discrepancy IS TRUE AND s.weight_diff_kg < 0";
  } else if (only === "missing_weight") {
    clause = "WHERE (s.invoiced_weight_kg IS NULL OR s.invoiced_weight_kg = 0)";
  }

  const { rows } = await queryDb(
    `SELECT
      i.invoice_no, i.reference_no AS invoice_reference_no, s.tracking_number, s.ship_date,
      s.recipient_name, s.recipient_country,
      s.service, s.reference,
      s.invoiced_weight_value, s.invoiced_weight_unit, s.invoiced_weight_kg,
      s.actual_weight_kg, s.actual_total_pieces, s.weight_diff_kg, s.weight_diff_pct,
      s.amount, s.currency, s.dispute_status, s.notes
    FROM shipments s
    JOIN invoices i ON i.id = s.invoice_id
    ${clause}
    ORDER BY i.invoice_no, s.row_no`,
    params
  );
  return rows;
}

// Summary metrics shown at the top of the Excel/PDF reports (not needed for
// the plain CSV, which is meant for further processing elsewhere).
export function summarizeReportRows(rows) {
  const invoiceNos = new Set(rows.map((r) => r.invoice_no));
  const totalDiffKg = rows.reduce((sum, r) => sum + (r.weight_diff_kg != null ? Number(r.weight_diff_kg) : 0), 0);
  const pctValues = rows.map((r) => (r.weight_diff_pct != null ? Number(r.weight_diff_pct) : null)).filter((v) => v != null);
  const avgDiffPct = pctValues.length ? pctValues.reduce((a, b) => a + b, 0) / pctValues.length : null;
  const byCurrency = {};
  for (const r of rows) {
    if (r.amount == null) continue;
    const cur = r.currency || "?";
    byCurrency[cur] = (byCurrency[cur] || 0) + Number(r.amount);
  }
  const byStatus = {};
  for (const r of rows) {
    const key = r.dispute_status || "none";
    byStatus[key] = (byStatus[key] || 0) + 1;
  }
  const notActioned = rows.filter((r) => (r.dispute_status || "none") === "none").length;

  return {
    shipmentCount: rows.length,
    invoiceCount: invoiceNos.size,
    totalDiffKg,
    avgDiffPct,
    byCurrency,
    byStatus,
    notActioned,
  };
}

// Single source of truth for the "Kapsam: ..." line shown at the top of the
// Excel and PDF reports - kept here (rather than duplicated in xlsxReport.js
// and pdfReport.js) so the wording for a given `only` value can never drift
// between the two formats. `fedexMinDisputeKg` is only needed to phrase the
// fedex_eligible/below_threshold labels with the actual configured
// threshold (Ayarlar → "FedEx Minimum İtiraz Eşiği", default 2 kg).
export function reportFilterLabel(only, fedexMinDisputeKg) {
  const kg = fedexMinDisputeKg ?? 2;
  switch (only) {
    case "all":
      return "Kapsam: Tüm gönderiler";
    case "fedex_eligible":
      return `Kapsam: İtiraz edilebilir gönderiler (≥${kg} kg fark)`;
    case "below_threshold":
      return `Kapsam: Eşik altı gönderiler (0-${kg} kg fark)`;
    case "negative":
      return "Kapsam: Negatif fark (eksik faturalandı)";
    case "missing_weight":
      return "Kapsam: Fatura ağırlığı eksik veya 0 görünen gönderiler";
    case "discrepancy":
    default:
      return "Kapsam: Farklı ağırlıklı gönderiler (tümü)";
  }
}

export { disputeStatusLabel };
