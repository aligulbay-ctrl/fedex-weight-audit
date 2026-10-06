import { ensureSchema, apiHandler } from "../../../../lib/db.js";
import { getShipmentHistorySummary, getShipmentHistoryRows, CATEGORIES, TOLERANCE_KG } from "../../../../lib/shipmentHistoryQueries.js";

export const runtime = "nodejs";

const PAGE_SIZE = 50;

export const GET = apiHandler(async (req) => {
  await ensureSchema();
  const { searchParams } = new URL(req.url);
  const category = searchParams.get("category") || "different";
  if (!CATEGORIES.includes(category)) {
    return Response.json({ error: `Geçersiz kategori: ${category}` }, { status: 400 });
  }
  const page = Math.max(parseInt(searchParams.get("page") || "1", 10), 1);
  const offset = (page - 1) * PAGE_SIZE;

  const [summary, { rows, matchingTotal }] = await Promise.all([
    getShipmentHistorySummary(),
    getShipmentHistoryRows(category, { limit: PAGE_SIZE, offset }),
  ]);

  return Response.json({
    toleranceKg: TOLERANCE_KG,
    summary,
    category,
    page,
    pageSize: PAGE_SIZE,
    matchingTotal,
    totalPages: Math.max(Math.ceil(matchingTotal / PAGE_SIZE), 1),
    rows,
  });
});
