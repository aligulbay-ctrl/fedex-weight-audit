import { ensureSchema, getClient, queryDb, apiHandler } from "../../../../lib/db.js";
import { evaluateDiscrepancy } from "../../../../lib/weightUtils.js";
import { getSettings } from "../../../../lib/settings.js";

export const runtime = "nodejs";

// PDF parsing happens in the BROWSER now (see app/upload/page.js), not here -
// a FedEx invoice PDF is often 5-7MB (embedded fonts/images from FedEx's own
// PDF generator) which blows straight through Vercel Serverless Functions'
// hard ~4.5MB request-body limit even one file at a time; the *parsed* data
// (a few hundred shipment rows as JSON) is only a few hundred KB no matter
// how large the source PDF was, so shipping that instead sidesteps the limit
// entirely rather than just working around it. This route now takes exactly
// that already-parsed JSON - one invoice per request, mirroring the previous
// one-file-per-request shape so the upload page's per-file progress/
// duplicate/force-retry UI didn't need to change.
export const POST = apiHandler(async (req) => {
  await ensureSchema();

  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Beklenen içerik: JSON gövde ({ filename, meta, rows })." }, { status: 400 });
  }

  const { filename, meta, rows, force } = body || {};
  if (!meta || typeof meta !== "object" || !Array.isArray(rows)) {
    return Response.json({ error: "Eksik veya hatalı istek gövdesi (meta/rows bulunamadı)." }, { status: 400 });
  }

  // Single invoice number the caller has explicitly confirmed overwriting
  // for - set when the user clicks "Yine de üzerine yaz" after seeing a
  // duplicate warning. Kept as a string (not a list) since this route only
  // ever handles one invoice per request now.
  const forceInvoiceNo = force ? String(force) : null;

  const results = [];

  try {
    if (!meta.invoiceNo) {
      results.push({ filename, ok: false, error: "Fatura numarası okunamadı - bu PDF beklenen FedEx fatura formatında olmayabilir." });
      return Response.json({ results });
    }
    if (rows.length === 0) {
      results.push({ filename, ok: false, error: "Hiç gönderi satırı bulunamadı - PDF formatı değişmiş olabilir." });
      return Response.json({ results });
    }

    // Duplicate-invoice guard: don't silently re-import/overwrite an invoice
    // that's already in the system - flag it and let the user explicitly
    // confirm ("force") before anything is touched.
    if (forceInvoiceNo !== meta.invoiceNo) {
      const { rows: existingRows } = await queryDb(
        `SELECT uploaded_at, filename, shipment_count FROM invoices WHERE invoice_no=$1`,
        [meta.invoiceNo]
      );
      const existing = existingRows[0];
      if (existing) {
        results.push({
          filename,
          ok: false,
          duplicate: true,
          invoiceNo: meta.invoiceNo,
          error: `Bu fatura (${meta.invoiceNo}) daha önce yüklenmiş (${existing.filename || "?"}, ${existing.shipment_count} gönderi) - yanlışlıkla tekrar yüklüyor olabilirsiniz.`,
          existing: { uploadedAt: existing.uploaded_at, filename: existing.filename, shipmentCount: existing.shipment_count },
        });
        return Response.json({ results });
      }
    }

    const settings = await getSettings();
    const thKg = settings.discrepancyThresholdKg;
    const thPct = settings.discrepancyThresholdPct;

    const client = await getClient();
    try {
      await client.query("BEGIN");

      const invRes = await client.query(
        `INSERT INTO invoices (invoice_no, invoice_date, due_date, customer_name, total_amount, currency, shipment_count, filename, reference_no)
         VALUES ($1,$2,$3,$4,$5,'TL',$6,$7,$8)
         ON CONFLICT (invoice_no) DO UPDATE SET
           invoice_date = EXCLUDED.invoice_date,
           due_date = EXCLUDED.due_date,
           customer_name = EXCLUDED.customer_name,
           total_amount = EXCLUDED.total_amount,
           shipment_count = EXCLUDED.shipment_count,
           filename = EXCLUDED.filename,
           reference_no = EXCLUDED.reference_no
         RETURNING id`,
        [meta.invoiceNo, meta.invoiceDate, meta.dueDate, meta.customerName, meta.totalAmount, rows.length, filename, meta.referenceNo]
      );
      const invoiceId = invRes.rows[0].id;

      let inserted = 0;
      for (const row of rows) {
        // Re-uploading the same invoice shouldn't wipe out actual weights
        // already fetched from FedEx - only recompute diff if we have one.
        const existing = await client.query(
          `SELECT actual_weight_kg FROM shipments WHERE invoice_id=$1 AND row_no=$2`,
          [invoiceId, row.rowNo]
        );
        const actualWeightKg = existing.rows[0]?.actual_weight_kg ?? null;
        const { diffKg, diffPct, isDiscrepancy } =
          actualWeightKg != null
            ? evaluateDiscrepancy(row.invoicedWeightKg, parseFloat(actualWeightKg), thKg, thPct)
            : { diffKg: null, diffPct: null, isDiscrepancy: null };

        await client.query(
          `INSERT INTO shipments (
             invoice_id, row_no, tracking_number, ship_date, delivery_date,
             recipient_name, recipient_country, recipient_address, service, reference,
             invoiced_weight_value, invoiced_weight_unit, invoiced_weight_kg, amount, currency,
             weight_diff_kg, weight_diff_pct, is_discrepancy
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'TL',$15,$16,$17)
           ON CONFLICT (invoice_id, row_no) DO UPDATE SET
             tracking_number = EXCLUDED.tracking_number,
             ship_date = EXCLUDED.ship_date,
             delivery_date = EXCLUDED.delivery_date,
             recipient_name = EXCLUDED.recipient_name,
             recipient_country = EXCLUDED.recipient_country,
             recipient_address = EXCLUDED.recipient_address,
             service = EXCLUDED.service,
             reference = EXCLUDED.reference,
             invoiced_weight_value = EXCLUDED.invoiced_weight_value,
             invoiced_weight_unit = EXCLUDED.invoiced_weight_unit,
             invoiced_weight_kg = EXCLUDED.invoiced_weight_kg,
             amount = EXCLUDED.amount,
             weight_diff_kg = EXCLUDED.weight_diff_kg,
             weight_diff_pct = EXCLUDED.weight_diff_pct,
             is_discrepancy = EXCLUDED.is_discrepancy`,
          [
            invoiceId, row.rowNo, row.trackingNumber, row.shipDate, row.deliveryDate,
            row.recipientName, row.recipientCountry, row.recipientAddress, row.service, row.reference,
            row.invoicedWeightValue, row.invoicedWeightUnit, row.invoicedWeightKg, row.amount,
            diffKg, diffPct, isDiscrepancy,
          ]
        );
        inserted++;
      }

      await client.query("COMMIT");
      // invoiceId lets the client attach the original PDF's Vercel Blob URL
      // to this exact row in a second step (see app/upload/page.js and
      // app/api/invoices/[id]/pdf/route.js) - after commit, so a PDF-storage
      // hiccup afterward can never affect the transaction above.
      results.push({ filename, ok: true, invoiceNo: meta.invoiceNo, invoiceId, rows: inserted });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    results.push({ filename, ok: false, error: err.message });
  }

  return Response.json({ results });
});
