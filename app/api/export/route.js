import { ensureSchema, apiHandler } from "../../../lib/db.js";
import { getReportRows, disputeStatusLabel } from "../../../lib/reportData.js";
import { getSettings } from "../../../lib/settings.js";

export const GET = apiHandler(async (req) => {
  await ensureSchema();
  const { searchParams } = new URL(req.url);
  const only = searchParams.get("only") || "discrepancy";
  const { fedexMinDisputeKg } = await getSettings();

  const rows = await getReportRows(only, { fedexMinDisputeKg });

  const header = [
    "Fatura No", "Fatura Referans No", "Takip No", "Gönderim Tarihi", "Alıcı", "Ülke", "Servis", "Referans",
    "Fatura Ağırlığı", "Birim", "Fatura Ağırlığı (kg)",
    "FedEx Gerçek Ağırlık (kg)", "FedEx Toplam Parça", "Fark (kg)", "Fark (%)",
    "Tutar", "Para Birimi", "İtiraz Durumu", "Not",
  ];

  const csvRows = [header.join(";")];
  for (const r of rows) {
    csvRows.push(
      [
        r.invoice_no, r.invoice_reference_no || "", r.tracking_number, r.ship_date || "", r.recipient_name || "", r.recipient_country || "",
        r.service || "", r.reference || "",
        r.invoiced_weight_value, r.invoiced_weight_unit, r.invoiced_weight_kg,
        r.actual_weight_kg ?? "", r.actual_total_pieces ?? "", r.weight_diff_kg ?? "", r.weight_diff_pct ?? "",
        r.amount, r.currency, disputeStatusLabel(r.dispute_status), csvEscape(r.notes),
      ].join(";")
    );
  }

  return new Response(csvRows.join("\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="fedex-agirlik-farklari-${only}.csv"`,
    },
  });
});

function csvEscape(v) {
  if (v == null) return "";
  const s = String(v);
  return s.includes(";") || s.includes("\n") ? `"${s.replace(/"/g, '""')}"` : s;
}
