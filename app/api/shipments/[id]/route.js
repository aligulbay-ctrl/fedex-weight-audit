import { ensureSchema, queryDb, apiHandler } from "../../../../lib/db.js";

// Lets the UI mark a flagged shipment as disputed with FedEx / resolved,
// and jot a note - purely bookkeeping, no FedEx call involved.
export const PATCH = apiHandler(async (req, { params }) => {
  await ensureSchema();
  const { id } = await params;
  const body = await req.json().catch(() => ({}));

  // Placeholder numbers are always derived from values.length (not
  // fields.length) below, since dispute_status now contributes TWO SQL
  // fragments (the column itself, plus the changed_at CASE) from a single
  // bound value - keeping them tied to fields.length like before would
  // silently misnumber every placeholder that follows.
  const fields = [];
  const values = [];
  if (body.disputeStatus !== undefined) {
    values.push(body.disputeStatus);
    const idx = values.length;
    fields.push(`dispute_status = $${idx}`);
    // Stamp dispute_status_changed_at only on an actual transition (old
    // value, read via IS DISTINCT FROM before this UPDATE takes effect,
    // differs from the new one) - this is what powers the "İtiraz Edildi
    // ne zamandır bekliyor" aging check in `only=stale`. Re-saving the same
    // status (or just editing notes) must NOT reset that clock.
    fields.push(
      `dispute_status_changed_at = CASE WHEN dispute_status IS DISTINCT FROM $${idx} THEN NOW() ELSE dispute_status_changed_at END`
    );
  }
  if (body.notes !== undefined) {
    values.push(body.notes);
    fields.push(`notes = $${values.length}`);
  }
  if (fields.length === 0) {
    return Response.json({ error: "Güncellenecek alan yok (disputeStatus veya notes bekleniyor)." }, { status: 400 });
  }
  values.push(id);

  await queryDb(`UPDATE shipments SET ${fields.join(", ")} WHERE id=$${values.length}`, values);
  return Response.json({ ok: true });
});

export const GET = apiHandler(async (req, { params }) => {
  await ensureSchema();
  const { id } = await params;
  const { rows } = await queryDb(
    `SELECT s.*, i.invoice_no FROM shipments s JOIN invoices i ON i.id = s.invoice_id WHERE s.id=$1`,
    [id]
  );
  if (!rows[0]) return Response.json({ error: "Bulunamadı" }, { status: 404 });
  return Response.json({ shipment: rows[0] });
});
