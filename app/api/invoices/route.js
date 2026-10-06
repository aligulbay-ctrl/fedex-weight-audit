import { ensureSchema, queryDb, apiHandler } from "../../../lib/db.js";

export const GET = apiHandler(async () => {
  await ensureSchema();
  const { rows } = await queryDb(`
    SELECT
      i.id, i.invoice_no, i.invoice_date, i.due_date, i.customer_name,
      i.total_amount, i.currency, i.shipment_count, i.filename, i.uploaded_at, i.reference_no,
      i.pdf_blob_url,
      COUNT(s.id) FILTER (WHERE s.is_discrepancy IS TRUE) AS discrepancy_count,
      COUNT(s.id) FILTER (WHERE s.actual_weight_kg IS NOT NULL) AS synced_count
    FROM invoices i
    LEFT JOIN shipments s ON s.invoice_id = i.id
    GROUP BY i.id
    ORDER BY i.invoice_date DESC NULLS LAST, i.id DESC
  `);
  return Response.json({ invoices: rows });
});
