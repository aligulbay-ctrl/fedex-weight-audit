import { ensureSchema, queryDb, apiHandler } from "../../../lib/db.js";
import { trackShipment, fedexConfigured } from "../../../lib/fedexClient.js";
import { evaluateDiscrepancy } from "../../../lib/weightUtils.js";
import { getSettings } from "../../../lib/settings.js";

export const runtime = "nodejs";

// Processes up to `limit` shipments that don't have an actual weight yet.
// Kept deliberately small per call (default 15) so this stays well inside
// a Vercel serverless function's time limit and FedEx's ~10 req/s cap.
// The UI calls this repeatedly ("Tümünü senkronize et") until `remaining`
// hits 0.
export const POST = apiHandler(async (req) => {
  await ensureSchema();

  if (!(await fedexConfigured())) {
    return Response.json({ error: "FedEx Client ID / Client Secret tanımlı değil (Ayarlar sayfasından girin)." }, { status: 400 });
  }

  let body = {};
  try {
    body = await req.json();
  } catch {
    // no body is fine, use defaults
  }
  const limit = Math.min(Math.max(parseInt(body.limit || "15", 10), 1), 50);
  const retryErrors = Boolean(body.retryErrors);

  const pendingClause = retryErrors ? `actual_weight_kg IS NULL` : `actual_weight_kg IS NULL AND fedex_error IS NULL`;

  const { rows: pending } = await queryDb(
    `SELECT id, tracking_number, invoiced_weight_kg FROM shipments WHERE ${pendingClause} ORDER BY id ASC LIMIT $1`,
    [limit]
  );

  const settings = await getSettings();
  const thKg = settings.discrepancyThresholdKg;
  const thPct = settings.discrepancyThresholdPct;
  let succeeded = 0;
  let failed = 0;

  for (const shipment of pending) {
    const result = await trackShipment(shipment.tracking_number);

    if (!result.ok) {
      failed++;
      await queryDb(
        `UPDATE shipments SET fedex_error=$1, fedex_raw_response=$2, actual_weight_fetched_at=NOW() WHERE id=$3`,
        [result.error, result.raw ? JSON.stringify(result.raw) : null, shipment.id]
      );
      continue;
    }

    // parseFloat(null) is NaN, not null/undefined - guard explicitly rather
    // than relying only on evaluateDiscrepancy's own NaN check (see its
    // comment) - a missing invoiced weight should read as "no invoiced
    // weight" here too, not silently become NaN.
    const invoicedWeightKg = shipment.invoiced_weight_kg != null ? parseFloat(shipment.invoiced_weight_kg) : null;
    const { diffKg, diffPct, isDiscrepancy } = evaluateDiscrepancy(
      invoicedWeightKg,
      result.actualWeightKg,
      thKg,
      thPct
    );

    await queryDb(
      `UPDATE shipments SET
         actual_weight_kg=$1, actual_weight_source=$2, actual_weight_fetched_at=NOW(),
         actual_total_pieces=$3,
         fedex_status=$4, fedex_raw_response=$5, fedex_error=NULL,
         weight_diff_kg=$6, weight_diff_pct=$7, is_discrepancy=$8
       WHERE id=$9`,
      [result.actualWeightKg, result.weightSource, result.totalPieces, result.status, JSON.stringify(result.raw), diffKg, diffPct, isDiscrepancy, shipment.id]
    );
    succeeded++;
  }

  const { rows: remainingRows } = await queryDb(
    `SELECT COUNT(*)::int AS n FROM shipments WHERE ${retryErrors ? "actual_weight_kg IS NULL" : "actual_weight_kg IS NULL AND fedex_error IS NULL"}`
  );

  return Response.json({
    processed: pending.length,
    succeeded,
    failed,
    remaining: remainingRows[0].n,
  });
});
