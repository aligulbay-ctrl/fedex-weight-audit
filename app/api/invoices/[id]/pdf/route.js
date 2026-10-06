import { ensureSchema, queryDb, apiHandler } from "../../../../../lib/db.js";

export const runtime = "nodejs";

// Attaches the Vercel Blob URL of the original PDF to an already-inserted
// invoice row - called by app/upload/page.js as a second, best-effort step
// AFTER the invoice+shipments themselves are safely committed (see
// app/api/invoices/upload/route.js), so a Blob-storage problem here can
// never roll back or block the actual data import.
export const PATCH = apiHandler(async (req, { params }) => {
  await ensureSchema();
  const { id } = await params;

  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Beklenen içerik: JSON gövde ({ pdfUrl })." }, { status: 400 });
  }
  const pdfUrl = body?.pdfUrl;
  if (!pdfUrl || typeof pdfUrl !== "string") {
    return Response.json({ error: "pdfUrl eksik." }, { status: 400 });
  }

  const { rows } = await queryDb(
    `UPDATE invoices SET pdf_blob_url=$1 WHERE id=$2 RETURNING id`,
    [pdfUrl, id]
  );
  if (!rows[0]) {
    return Response.json({ error: "Fatura bulunamadı." }, { status: 404 });
  }
  return Response.json({ ok: true });
});
