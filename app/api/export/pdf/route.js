import { ensureSchema, apiHandler } from "../../../../lib/db.js";
import { getReportRows, summarizeReportRows } from "../../../../lib/reportData.js";
import { buildDiscrepancyPdfBuffer } from "../../../../lib/pdfReport.js";
import { getSettings } from "../../../../lib/settings.js";

export const runtime = "nodejs";

export const GET = apiHandler(async (req) => {
  await ensureSchema();
  const { searchParams } = new URL(req.url);
  const only = searchParams.get("only") || "discrepancy";
  const { fedexMinDisputeKg } = await getSettings();

  const rows = await getReportRows(only, { fedexMinDisputeKg });
  const summary = summarizeReportRows(rows);
  const buffer = await buildDiscrepancyPdfBuffer(rows, summary, { only, generatedAt: new Date(), fedexMinDisputeKg });

  return new Response(buffer, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="fedex-agirlik-farklari-${only}.pdf"`,
    },
  });
});
