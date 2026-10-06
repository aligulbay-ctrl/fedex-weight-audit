import { ensureSchema, queryDb, apiHandler } from "../../../../../lib/db.js";

// Looked up by tracking_number (not a hard FK) - the same tracking number
// can legitimately appear as a separate shipment row on more than one
// invoice (see README), and a dispute email should show up against all of
// them, not just whichever one happened to get matched_shipment_id first.
export const GET = apiHandler(async (req, { params }) => {
  await ensureSchema();
  const { id } = await params;

  const { rows: shipRows } = await queryDb(`SELECT tracking_number FROM shipments WHERE id = $1`, [id]);
  const shipment = shipRows[0];
  if (!shipment) return Response.json({ error: "Gönderi bulunamadı." }, { status: 404 });

  const { rows } = await queryDb(
    `SELECT id, gmail_message_id, gmail_thread_id, subject, from_address, received_at,
            ref_no, invoice_no, tracking_number, account_number, dispute_date,
            contact_name, contact_email, weight_value, weight_unit, dispute_reason,
            snippet, body_text, created_at
     FROM dispute_emails
     WHERE tracking_number = $1
     ORDER BY received_at DESC NULLS LAST, id DESC`,
    [shipment.tracking_number]
  );

  return Response.json({ emails: rows });
});
