import { ensureSchema, queryDb, apiHandler } from "../../../lib/db.js";
import { getSettings } from "../../../lib/settings.js";

export const GET = apiHandler(async (req) => {
  await ensureSchema();
  const { searchParams } = new URL(req.url);
  const only = searchParams.get("only"); // "discrepancy" | "pending" | "stale" | "fedex_eligible" | "below_threshold" | "negative" | null
  const invoiceId = searchParams.get("invoiceId");
  const search = searchParams.get("search");
  // Pagination: 50 rows/page by default (the dashboard's own page size), a
  // caller can still ask for a bigger single page via `limit` up to 1000.
  const limit = Math.min(parseInt(searchParams.get("limit") || "50", 10), 1000);
  const page = Math.max(parseInt(searchParams.get("page") || "1", 10), 1);
  const offset = (page - 1) * limit;
  const { disputeStaleDays, fedexMinDisputeKg } = await getSettings();

  const clauses = [];
  const params = [];

  if (only === "discrepancy") clauses.push(`s.is_discrepancy IS TRUE`);
  if (only === "pending") clauses.push(`s.actual_weight_kg IS NULL`);
  if (only === "error") clauses.push(`s.fedex_error IS NOT NULL AND s.actual_weight_kg IS NULL`);
  if (only === "review") clauses.push(`s.dispute_status IN ('flagged','disputed')`);
  if (only === "stale") {
    params.push(disputeStaleDays);
    clauses.push(
      `s.dispute_status = 'disputed' AND s.dispute_status_changed_at < NOW() - ($${params.length} * INTERVAL '1 day')`
    );
  }
  // Three-way split of flagged discrepancies by fark (kg) - mutually
  // exclusive and together cover every is_discrepancy row exactly once:
  // fedex_eligible (>= threshold) is worth actually filing with FedEx;
  // below_threshold (0 <= fark < threshold) is a real discrepancy but below
  // what FedEx is understood to act on; negative (fark < 0) means FedEx's
  // own weight came back HIGHER than invoiced - the customer was
  // undercharged, not overcharged, so it's not a dispute case at all, just
  // worth being aware of. Threshold is fedexMinDisputeKg (Ayarlar, default 2 kg).
  if (only === "fedex_eligible") {
    params.push(fedexMinDisputeKg);
    clauses.push(`s.is_discrepancy IS TRUE AND s.weight_diff_kg >= $${params.length}`);
  }
  if (only === "below_threshold") {
    params.push(fedexMinDisputeKg);
    clauses.push(`s.is_discrepancy IS TRUE AND s.weight_diff_kg >= 0 AND s.weight_diff_kg < $${params.length}`);
  }
  if (only === "negative") {
    clauses.push(`s.is_discrepancy IS TRUE AND s.weight_diff_kg < 0`);
  }
  // Rows where the invoice PDF's own weight column never made it into the
  // system at all (parser couldn't read that line, or it read as a literal
  // 0) - these can never get a fark/diff computed against them (there's
  // nothing to compare FedEx's real weight to), so they're worth a
  // dedicated place to review separately from "farklı ağırlık" - see
  // lib/weightUtils.js's evaluateDiscrepancy comment for the NaN bug this
  // was surfaced by.
  if (only === "missing_weight") {
    clauses.push(`(s.invoiced_weight_kg IS NULL OR s.invoiced_weight_kg = 0)`);
  }

  // FedEx'in kendi sisteminden çekilen GERÇEK ağırlığa göre alt sınır -
  // faturadaki değil, Track API'den gelen actual_weight_kg'a bakar. Diğer
  // filtrelerle (only=, search) birlikte AND'lenir, örn. "Tümü" + bu eşik
  // birlikte kullanılabilir. Henüz senkronize edilmemiş (actual_weight_kg
  // NULL) gönderiler bu filtreyle hiçbir zaman eşleşmez - beklenen davranış.
  const minFedexWeightKg = searchParams.get("minFedexWeightKg");
  if (minFedexWeightKg && !Number.isNaN(parseFloat(minFedexWeightKg))) {
    params.push(parseFloat(minFedexWeightKg));
    clauses.push(`s.actual_weight_kg >= $${params.length}`);
  }

  if (invoiceId) {
    params.push(invoiceId);
    clauses.push(`s.invoice_id = $${params.length}`);
  }
  if (search) {
    params.push(`%${search}%`);
    // s.reference is the per-shipment "Servis Referans" from the invoice
    // table; i.reference_no is the invoice-level "Referans No:" from the
    // e-Fatura header (see lib/pdfParser.js) - search matches either, so
    // searching for either kind of reference number finds the shipment.
    clauses.push(
      `(s.tracking_number ILIKE $${params.length} OR s.recipient_name ILIKE $${params.length} OR s.reference ILIKE $${params.length} OR i.reference_no ILIKE $${params.length})`
    );
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  // Whitelisted ORDER BY options - never build ORDER BY from raw user input.
  const SORTS = {
    default: `s.is_discrepancy DESC NULLS LAST, ABS(COALESCE(s.weight_diff_kg,0)) DESC, s.ship_date DESC NULLS LAST`,
    status: `CASE s.dispute_status
                WHEN 'flagged' THEN 1
                WHEN 'disputed' THEN 2
                WHEN 'credit_note' THEN 3
                WHEN 'resolved' THEN 4
                ELSE 5
              END ASC, ABS(COALESCE(s.weight_diff_kg,0)) DESC, s.ship_date DESC NULLS LAST`,
    diff_desc: `ABS(COALESCE(s.weight_diff_kg,0)) DESC, s.ship_date DESC NULLS LAST`,
    date_desc: `s.ship_date DESC NULLS LAST, s.row_no DESC`,
    date_asc: `s.ship_date ASC NULLS LAST, s.row_no ASC`,
    // Clickable-column-header sorts (Fatura Ağırlığı / FedEx Gerçek /
    // Toplam Parça / Fark on the dashboard table) - unlike diff_desc above
    // (which sorts by |fark|, for "biggest discrepancy first" regardless of
    // over/under), these sort by the raw signed value like a spreadsheet
    // column would. NULLS LAST in both directions so rows still waiting on
    // a value (e.g. actual_weight_kg before FedEx sync) sink to the bottom
    // either way instead of clumping at the top of an ascending sort.
    invoiced_weight_asc: `s.invoiced_weight_kg ASC NULLS LAST, s.ship_date DESC NULLS LAST`,
    invoiced_weight_desc: `s.invoiced_weight_kg DESC NULLS LAST, s.ship_date DESC NULLS LAST`,
    actual_weight_asc: `s.actual_weight_kg ASC NULLS LAST, s.ship_date DESC NULLS LAST`,
    actual_weight_desc: `s.actual_weight_kg DESC NULLS LAST, s.ship_date DESC NULLS LAST`,
    pieces_asc: `s.actual_total_pieces ASC NULLS LAST, s.ship_date DESC NULLS LAST`,
    pieces_desc: `s.actual_total_pieces DESC NULLS LAST, s.ship_date DESC NULLS LAST`,
    diff_kg_asc: `s.weight_diff_kg ASC NULLS LAST, s.ship_date DESC NULLS LAST`,
    diff_kg_desc: `s.weight_diff_kg DESC NULLS LAST, s.ship_date DESC NULLS LAST`,
  };
  const requestedSort = searchParams.get("sort");
  const orderBy = SORTS[requestedSort] || SORTS.default;

  // Total rows matching the CURRENT filter/search (not the global stats
  // below, which are always unfiltered) - this is what the dashboard's
  // pager divides by `limit` to show "Sayfa X / Y". Computed with the exact
  // same WHERE/params as the main query, just before LIMIT/OFFSET are
  // appended to `params` for that query.
  const countRes = await queryDb(
    `SELECT COUNT(*) AS n FROM shipments s JOIN invoices i ON i.id = s.invoice_id ${where}`,
    params
  );
  const matchingTotal = parseInt(countRes.rows[0].n, 10);

  params.push(limit, offset);

  const { rows } = await queryDb(
    `SELECT
       s.id, s.invoice_id, s.row_no, s.tracking_number, s.ship_date, s.delivery_date,
       s.recipient_name, s.recipient_country, s.service, s.reference,
       s.invoiced_weight_value, s.invoiced_weight_unit, s.invoiced_weight_kg,
       s.amount, s.currency,
       s.actual_weight_kg, s.actual_weight_source, s.actual_weight_fetched_at, s.actual_total_pieces,
       s.fedex_status, s.fedex_error,
       s.weight_diff_kg, s.weight_diff_pct, s.is_discrepancy,
       s.dispute_status, s.dispute_ref, s.notes, s.dispute_status_changed_at,
       EXTRACT(DAY FROM NOW() - s.dispute_status_changed_at)::int AS days_in_dispute,
       i.invoice_no, i.reference_no AS invoice_reference_no,
       COALESCE(de.email_count, 0) AS dispute_email_count
     FROM shipments s
     JOIN invoices i ON i.id = s.invoice_id
     LEFT JOIN (
       SELECT tracking_number, COUNT(*) AS email_count
       FROM dispute_emails
       GROUP BY tracking_number
     ) de ON de.tracking_number = s.tracking_number
     ${where}
     ORDER BY ${orderBy}
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  const stats = await queryDb(
    `SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE is_discrepancy IS TRUE) AS discrepancies,
      COUNT(*) FILTER (WHERE actual_weight_kg IS NULL) AS pending,
      COUNT(*) FILTER (WHERE fedex_error IS NOT NULL AND actual_weight_kg IS NULL) AS errors,
      COUNT(*) FILTER (WHERE dispute_status IN ('flagged','disputed')) AS review,
      COUNT(*) FILTER (
        WHERE dispute_status = 'disputed' AND dispute_status_changed_at < NOW() - ($1 * INTERVAL '1 day')
      ) AS stale,
      COUNT(*) FILTER (WHERE is_discrepancy IS TRUE AND weight_diff_kg >= $2) AS fedex_eligible,
      COUNT(*) FILTER (WHERE is_discrepancy IS TRUE AND weight_diff_kg >= 0 AND weight_diff_kg < $2) AS below_threshold,
      COUNT(*) FILTER (WHERE is_discrepancy IS TRUE AND weight_diff_kg < 0) AS negative,
      COUNT(*) FILTER (WHERE invoiced_weight_kg IS NULL OR invoiced_weight_kg = 0) AS missing_weight
    FROM shipments`,
    [disputeStaleDays, fedexMinDisputeKg]
  );

  return Response.json({
    shipments: rows,
    stats: stats.rows[0],
    page,
    pageSize: limit,
    matchingTotal,
    totalPages: Math.max(Math.ceil(matchingTotal / limit), 1),
  });
});
