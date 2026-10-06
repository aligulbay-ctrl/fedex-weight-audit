// Shared query layer for the "Gönderi Geçmişi Karşılaştırma" module -
// reused identically by the paginated on-screen list
// (app/api/shipment-history/list/route.js) and the full Excel export
// (app/api/shipment-history/export/route.js) so the two never drift, same
// pattern as lib/reportData.js for the invoice-based reports.
import { queryDb } from "./db.js";

// Below this, a gap between the Ship History export's totalShipmentWeight
// and FedEx Track API's actual_weight_kg is treated as rounding noise
// (Ship History often records weight to 1 decimal, Track API to 2-3) rather
// than a real discrepancy - this is a sanity check between two FedEx-side
// records, not a billing-dispute threshold, so it stays fixed rather than
// reusing the configurable fedexMinDisputeKg from Ayarlar.
export const TOLERANCE_KG = 0.1;

export const CATEGORIES = ["all", "same", "different", "notYetTracked", "fedexOnly"];

// A tracking number can legitimately appear on more than one invoice line
// (see the dispute_emails comment in lib/db.js) - these scalar subqueries
// always resolve to at most one shipments row per history row (preferring
// one that's actually been synced with FedEx, if any exist), so every
// query built from this CTE returns exactly one row per uploaded shipment,
// never fanned out by a join.
const HISTORY_BASE_CTE = `
  WITH matched AS (
    SELECT
      h.id, h.master_tracking_number, h.ship_date, h.reference,
      h.total_shipment_weight, h.weight_unit, h.total_shipment_weight_kg,
      (SELECT s.actual_weight_kg FROM shipments s
        WHERE s.tracking_number = h.master_tracking_number
        ORDER BY (s.actual_weight_kg IS NOT NULL) DESC, s.id LIMIT 1) AS actual_weight_kg,
      (SELECT i.invoice_no FROM shipments s JOIN invoices i ON i.id = s.invoice_id
        WHERE s.tracking_number = h.master_tracking_number
        ORDER BY (s.actual_weight_kg IS NOT NULL) DESC, s.id LIMIT 1) AS invoice_no,
      EXISTS (SELECT 1 FROM shipments s2 WHERE s2.tracking_number = h.master_tracking_number) AS has_invoice_line
    FROM fedex_shipment_history h
  ),
  scored AS (
    SELECT *,
      CASE WHEN actual_weight_kg IS NULL OR total_shipment_weight_kg IS NULL THEN NULL
           ELSE ABS(total_shipment_weight_kg - actual_weight_kg) END AS diff_kg
    FROM matched
  )
`;

function categoryWhere(category) {
  switch (category) {
    case "same":
      return `WHERE diff_kg IS NOT NULL AND diff_kg <= $1`;
    case "different":
      return `WHERE diff_kg IS NOT NULL AND diff_kg > $1`;
    case "notYetTracked":
      return `WHERE actual_weight_kg IS NULL`;
    case "all":
      return ``;
    default:
      throw new Error(`Unknown category: ${category}`);
  }
}

// Counts for all five cards at once - always computed regardless of which
// category is currently on screen, so the card row never goes stale.
export async function getShipmentHistorySummary() {
  const totalRes = await queryDb(`SELECT COUNT(*) AS n FROM fedex_shipment_history`);
  const totalUploaded = parseInt(totalRes.rows[0].n, 10);

  const res = await queryDb(
    `${HISTORY_BASE_CTE}
     SELECT
       COUNT(*) FILTER (WHERE diff_kg IS NOT NULL AND diff_kg <= $1) AS same,
       COUNT(*) FILTER (WHERE diff_kg IS NOT NULL AND diff_kg > $1) AS different,
       COUNT(*) FILTER (WHERE actual_weight_kg IS NULL) AS not_yet_tracked
     FROM scored`,
    [TOLERANCE_KG]
  );
  const row = res.rows[0];

  const fedexOnlyRes = await queryDb(
    `SELECT COUNT(*) AS n FROM shipments s
     WHERE s.actual_weight_kg IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM fedex_shipment_history h WHERE h.master_tracking_number = s.tracking_number)`
  );

  return {
    totalUploaded,
    same: parseInt(row.same, 10),
    different: parseInt(row.different, 10),
    notYetTracked: parseInt(row.not_yet_tracked, 10),
    fedexOnly: parseInt(fedexOnlyRes.rows[0].n, 10),
  };
}

// One page (or, with limit=null, every row - used by the Excel export) of
// a single category. fedexOnly's base table is `shipments`, not
// fedex_shipment_history, so it's handled separately from the other four.
export async function getShipmentHistoryRows(category, { limit = null, offset = 0 } = {}) {
  if (!CATEGORIES.includes(category)) throw new Error(`Unknown category: ${category}`);

  if (category === "fedexOnly") {
    const countRes = await queryDb(
      `SELECT COUNT(*) AS n FROM shipments s
       WHERE s.actual_weight_kg IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM fedex_shipment_history h WHERE h.master_tracking_number = s.tracking_number)`
    );
    const matchingTotal = parseInt(countRes.rows[0].n, 10);

    const params = [];
    let limitSql = "";
    if (limit != null) {
      params.push(limit, offset);
      limitSql = `LIMIT $${params.length - 1} OFFSET $${params.length}`;
    }
    const dataRes = await queryDb(
      `SELECT s.tracking_number AS master_tracking_number, s.ship_date, s.actual_weight_kg,
              i.invoice_no, i.reference_no AS invoice_reference_no
       FROM shipments s
       JOIN invoices i ON i.id = s.invoice_id
       WHERE s.actual_weight_kg IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM fedex_shipment_history h WHERE h.master_tracking_number = s.tracking_number)
       ORDER BY s.ship_date DESC NULLS LAST
       ${limitSql}`,
      params
    );
    return { rows: dataRes.rows, matchingTotal };
  }

  const where = categoryWhere(category);
  // Only "same"/"different" reference $1 (the tolerance) in their WHERE
  // clause - passing it for "all"/"notYetTracked" too makes Postgres
  // reject the query ("bind message supplies N parameters, but prepared
  // statement requires 0"), since pg won't accept unused bind params.
  const baseParams = category === "same" || category === "different" ? [TOLERANCE_KG] : [];

  const countRes = await queryDb(`${HISTORY_BASE_CTE} SELECT COUNT(*) AS n FROM scored ${where}`, baseParams);
  const matchingTotal = parseInt(countRes.rows[0].n, 10);

  const params = [...baseParams];
  let limitSql = "";
  if (limit != null) {
    params.push(limit, offset);
    limitSql = `LIMIT $${params.length - 1} OFFSET $${params.length}`;
  }
  const dataRes = await queryDb(
    `${HISTORY_BASE_CTE}
     SELECT master_tracking_number, ship_date, reference, total_shipment_weight, weight_unit,
            total_shipment_weight_kg, actual_weight_kg, invoice_no, has_invoice_line, diff_kg
     FROM scored
     ${where}
     ORDER BY ship_date DESC NULLS LAST
     ${limitSql}`,
    params
  );
  return { rows: dataRes.rows, matchingTotal };
}

export function categoryLabel(category) {
  switch (category) {
    case "all": return "Yüklenen Tüm Gönderiler";
    case "same": return "Aynı (Fark Yok)";
    case "different": return "Farklı Olanlar";
    case "notYetTracked": return "Excel'de Var, Henüz FedEx Takibinde Yok";
    case "fedexOnly": return "FedEx Takibinde Var, Excel'de Yok";
    default: return category;
  }
}
