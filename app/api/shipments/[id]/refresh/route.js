import { ensureSchema, queryDb, apiHandler } from "../../../../../lib/db.js";
import { trackShipment, fedexConfigured } from "../../../../../lib/fedexClient.js";
import { evaluateDiscrepancy } from "../../../../../lib/weightUtils.js";
import { getSettings } from "../../../../../lib/settings.js";

export const POST = apiHandler(async (req, { params }) => {
  await ensureSchema();
  const { id } = await params;

  if (!(await fedexConfigured())) {
    return Response.json({ error: "FedEx Client ID / Client Secret tanımlı değil (Ayarlar sayfasından girin)." }, { status: 400 });
  }

  const { rows } = await queryDb(`SELECT id, tracking_number, invoiced_weight_kg FROM shipments WHERE id=$1`, [id]);
  const shipment = rows[0];
  if (!shipment) return Response.json({ error: "Gönderi bulunamadı." }, { status: 404 });

  const result = await trackShipment(shipment.tracking_number);
  const settings = await getSettings();
  const thKg = settings.discrepancyThresholdKg;
  const thPct = settings.discrepancyThresholdPct;

  if (!result.ok) {
    await queryDb(
      `UPDATE shipments SET fedex_error=$1, fedex_raw_response=$2, actual_weight_fetched_at=NOW() WHERE id=$3`,
      [result.error, result.raw ? JSON.stringify(result.raw) : null, id]
    );
    return Response.json({ ok: false, error: result.error });
  }

  // parseFloat(null) is NaN, not null/undefined - guard explicitly rather
  // than relying only on evaluateDiscrepancy's own NaN check, so a missing
  // invoiced weight (parser couldn't read that row's weight from the PDF)
  // reads clearly as "no invoiced weight" at this call site too.
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
    [result.actualWeightKg, result.weightSource, result.totalPieces, result.status, JSON.stringify(result.raw), diffKg, diffPct, isDiscrepancy, id]
  );

  return Response.json({ ok: true, actualWeightKg: result.actualWeightKg, diffKg, diffPct, isDiscrepancy });
});
