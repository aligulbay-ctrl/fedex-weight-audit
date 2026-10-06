import { ensureSchema, getClient, apiHandler } from "../../../../lib/db.js";

export const runtime = "nodejs";

// Accepts already-parsed records from a FedEx Ship History export - parsing
// happens in the browser (see lib/shipmentHistoryParser.js /
// app/shipment-history/page.js), same reasoning as the invoice upload: this
// export can be a large file (years of history, thousands of rows) and only
// the small parsed result needs to reach the server.
export const POST = apiHandler(async (req) => {
  await ensureSchema();

  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Beklenen içerik: JSON gövde ({ filename, records })." }, { status: 400 });
  }

  const { filename, records } = body || {};
  if (!Array.isArray(records)) {
    return Response.json({ error: "Eksik veya hatalı istek gövdesi (records bulunamadı)." }, { status: 400 });
  }
  if (records.length === 0) {
    return Response.json({ ok: true, inserted: 0, message: "Dosyada işlenecek geçerli gönderi bulunamadı." });
  }

  const client = await getClient();
  try {
    await client.query("BEGIN");
    let inserted = 0;
    for (const rec of records) {
      if (!rec.masterTrackingNumber) continue;
      await client.query(
        `INSERT INTO fedex_shipment_history (
           master_tracking_number, ship_date, reference, number_of_packages,
           total_shipment_weight, weight_unit, total_shipment_weight_kg, status, source_filename
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (master_tracking_number) DO UPDATE SET
           ship_date = EXCLUDED.ship_date,
           reference = EXCLUDED.reference,
           number_of_packages = EXCLUDED.number_of_packages,
           total_shipment_weight = EXCLUDED.total_shipment_weight,
           weight_unit = EXCLUDED.weight_unit,
           total_shipment_weight_kg = EXCLUDED.total_shipment_weight_kg,
           status = EXCLUDED.status,
           source_filename = EXCLUDED.source_filename,
           uploaded_at = NOW()`,
        [
          rec.masterTrackingNumber,
          rec.shipDate || null,
          rec.reference || null,
          rec.numberOfPackages || null,
          rec.totalShipmentWeight ?? null,
          rec.weightUnit || null,
          rec.totalShipmentWeightKg ?? null,
          rec.status || null,
          filename || null,
        ]
      );
      inserted++;
    }
    await client.query("COMMIT");
    return Response.json({ ok: true, inserted });
  } catch (err) {
    await client.query("ROLLBACK");
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  } finally {
    client.release();
  }
});
