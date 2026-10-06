import { ensureSchema, apiHandler } from "../../../../lib/db.js";
import { getShipmentHistoryRows, CATEGORIES } from "../../../../lib/shipmentHistoryQueries.js";
import { buildShipmentHistoryXlsx } from "../../../../lib/shipmentHistoryXlsxReport.js";

export const runtime = "nodejs";

export const GET = apiHandler(async (req) => {
  await ensureSchema();
  const { searchParams } = new URL(req.url);
  const category = searchParams.get("category") || "different";
  if (!CATEGORIES.includes(category)) {
    return Response.json({ error: `Geçersiz kategori: ${category}` }, { status: 400 });
  }

  // No limit here (unlike the on-screen list, which paginates 50/page) -
  // the export is meant to be the complete list for that category.
  const { rows } = await getShipmentHistoryRows(category, { limit: null });
  const buffer = await buildShipmentHistoryXlsx(category, rows, { generatedAt: new Date() });

  return new Response(buffer, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="gonderi-gecmisi-${category}.xlsx"`,
    },
  });
});
