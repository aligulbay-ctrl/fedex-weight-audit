import { ensureSchema, queryDb, apiHandler } from "../../../../lib/db.js";
import { del } from "@vercel/blob";

// Deletes an uploaded invoice and every shipment row that came from it.
// `shipments.invoice_id` has ON DELETE CASCADE (see lib/db.js), so the
// DELETE below removes both in one statement - no separate cleanup pass
// needed. Any Gmail dispute-email rows matched to one of those shipments
// (dispute_emails.matched_shipment_id, ON DELETE SET NULL) simply lose
// their match and are kept as-is, since they're independent records of a
// real email that was received - deleting the invoice shouldn't erase that.
export const DELETE = apiHandler(async (req, { params }) => {
  await ensureSchema();
  const { id } = await params;

  const { rows } = await queryDb(
    `DELETE FROM invoices WHERE id=$1 RETURNING invoice_no, filename, shipment_count, pdf_blob_url`,
    [id]
  );
  if (!rows[0]) {
    return Response.json({ error: "Fatura bulunamadı (zaten silinmiş olabilir)." }, { status: 404 });
  }
  // Best-effort - the invoice row is already gone either way, so a Blob
  // storage hiccup (or Blob simply not configured) here shouldn't turn a
  // successful delete into an error response.
  if (rows[0].pdf_blob_url) {
    try {
      await del(rows[0].pdf_blob_url);
    } catch (err) {
      console.error("[blob delete failed]", err);
    }
  }
  return Response.json({ ok: true, deleted: rows[0] });
});
