import { ensureSchema, apiHandler } from "../../../../lib/db.js";
import { getReportRows, summarizeReportRows } from "../../../../lib/reportData.js";
import { buildDiscrepancyXlsxBuffer } from "../../../../lib/xlsxReport.js";
import { getSettings } from "../../../../lib/settings.js";

export const runtime = "nodejs";

export const GET = apiHandler(async (req) => {
  await ensureSchema();
  const { searchParams } = new URL(req.url);
  const only = searchParams.get("only") || "discrepancy";
  const { fedexMinDisputeKg } = await getSettings();

  const rows = await getReportRows(only, { fedexMinDisputeKg });
  const summary = summarizeReportRows(rows);
  const buffer = await buildDiscrepancyXlsxBuffer(rows, summary, { only, generatedAt: new Date(), fedexMinDisputeKg });

  return new Response(buffer, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="fedex-agirlik-farklari-${only}.xlsx"`,
    },
  });
});
