// Formatted, colored .xlsx report for weight-discrepancy shipments - two
// sheets ("Özet" summary + "Gönderiler" detail table), styled to match the
// dashboard's own color language (brand blue / danger red / warn amber from
// app/globals.css) so the exported report still reads as "this app's
// output" once it's opened in Excel or forwarded to someone else.
import ExcelJS from "exceljs";
import { disputeStatusLabel } from "./statusLabels.js";
import { reportFilterLabel } from "./reportData.js";
import { toLb } from "./weightUtils.js";

// Converts a kg value to the invoice row's own unit (LB rows -> lb, KG rows
// or an unrecognized unit -> left as kg) - used for the "(birim)" columns
// below so "FedEx Gerçek" and "Fark" can be read in the same unit the
// invoice was billed in, sitting right next to the always-kg columns that
// keep the sheet summable/sortable across rows with mixed units.
function inInvoiceUnit(kgValue, unit) {
  if (kgValue == null) return null;
  return unit === "LB" ? toLb(Number(kgValue)) : Number(kgValue);
}

const BRAND = "FF006CE0";
const BRAND_SOFT = "FFE7F0FE";
const DANGER = "FFD13212";
const DANGER_SOFT = "FFFDF3F1";
const WARN = "FFE77600";
const WARN_SOFT = "FFFFF1E0";
const HEADER_TEXT = "FFFFFFFF";
const MUTED = "FF6B7280";

function severityFill(pct) {
  if (pct == null) return null;
  const abs = Math.abs(pct);
  if (abs >= 20) return DANGER_SOFT;
  if (abs >= 10) return WARN_SOFT;
  return null;
}

export async function buildDiscrepancyXlsxBuffer(rows, summary, { only, generatedAt, fedexMinDisputeKg } = {}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Coolart Tekstil - FedEx Ağırlık Kontrolü";
  wb.created = generatedAt || new Date(0); // caller passes a real Date; fallback keeps this pure/deterministic

  // ---- Sheet 1: Özet ----------------------------------------------------
  const summarySheet = wb.addWorksheet("Özet");
  summarySheet.columns = [{ width: 34 }, { width: 24 }];

  summarySheet.mergeCells("A1:B1");
  const title = summarySheet.getCell("A1");
  title.value = "Coolart Tekstil — FedEx Ağırlık Farkı Raporu";
  title.font = { size: 16, bold: true, color: { argb: BRAND } };
  summarySheet.getRow(1).height = 26;

  summarySheet.getCell("A2").value = reportFilterLabel(only, fedexMinDisputeKg);
  summarySheet.getCell("A2").font = { italic: true, color: { argb: MUTED } };
  summarySheet.getCell("A3").value = `Oluşturulma: ${formatDateTime(generatedAt)}`;
  summarySheet.getCell("A3").font = { italic: true, color: { argb: MUTED } };

  const metrics = [
    ["Toplam gönderi", summary.shipmentCount],
    ["Fatura sayısı", summary.invoiceCount],
    ["Toplam ağırlık farkı (kg)", round2(summary.totalDiffKg)],
    ["Ortalama fark (%)", summary.avgDiffPct != null ? round2(summary.avgDiffPct) : "—"],
    ["Henüz işaretlenmemiş (—)", summary.notActioned],
  ];
  let r = 5;
  summarySheet.getCell(`A${r}`).value = "Özet";
  summarySheet.getCell(`A${r}`).font = { bold: true, size: 12 };
  r++;
  for (const [label, value] of metrics) {
    const labelCell = summarySheet.getCell(`A${r}`);
    const valueCell = summarySheet.getCell(`B${r}`);
    labelCell.value = label;
    valueCell.value = value;
    valueCell.font = { bold: true };
    valueCell.alignment = { horizontal: "right" };
    r++;
  }

  r++;
  summarySheet.getCell(`A${r}`).value = "Para birimine göre toplam tutar";
  summarySheet.getCell(`A${r}`).font = { bold: true, size: 12 };
  r++;
  const currencies = Object.keys(summary.byCurrency);
  if (!currencies.length) {
    summarySheet.getCell(`A${r}`).value = "—";
    r++;
  }
  for (const cur of currencies) {
    summarySheet.getCell(`A${r}`).value = cur;
    const cell = summarySheet.getCell(`B${r}`);
    cell.value = round2(summary.byCurrency[cur]);
    cell.numFmt = "#,##0.00";
    cell.alignment = { horizontal: "right" };
    r++;
  }

  r++;
  summarySheet.getCell(`A${r}`).value = "İtiraz durumuna göre gönderi sayısı";
  summarySheet.getCell(`A${r}`).font = { bold: true, size: 12 };
  r++;
  const statusOrder = ["none", "flagged", "disputed", "approved", "credit_note", "resolved"];
  for (const status of statusOrder) {
    const count = summary.byStatus[status] || 0;
    if (!count) continue;
    summarySheet.getCell(`A${r}`).value = disputeStatusLabel(status);
    const cell = summarySheet.getCell(`B${r}`);
    cell.value = count;
    cell.alignment = { horizontal: "right" };
    r++;
  }

  // ---- Sheet 2: Gönderiler -----------------------------------------------
  const sheet = wb.addWorksheet("Gönderiler", { views: [{ state: "frozen", ySplit: 1 }] });
  const columns = [
    { header: "Fatura No", key: "invoice_no", width: 18 },
    { header: "Fatura Ref.", key: "invoice_reference_no", width: 14 },
    { header: "Takip No", key: "tracking_number", width: 16 },
    { header: "Gönderim Tarihi", key: "ship_date", width: 14 },
    { header: "Alıcı", key: "recipient_name", width: 24 },
    { header: "Ülke", key: "recipient_country", width: 16 },
    { header: "Servis", key: "service", width: 20 },
    { header: "Referans", key: "reference", width: 14 },
    { header: "Fatura Ağırlığı", key: "invoiced_weight_value", width: 14 },
    { header: "Birim", key: "invoiced_weight_unit", width: 8 },
    { header: "Fatura Ağırlığı (kg)", key: "invoiced_weight_kg", width: 16 },
    { header: "FedEx Gerçek (birim)", key: "actual_weight_invoice_unit", width: 17 },
    { header: "FedEx Gerçek (kg)", key: "actual_weight_kg", width: 16 },
    { header: "Toplam Parça", key: "actual_total_pieces", width: 12 },
    { header: "Fark (birim)", key: "weight_diff_invoice_unit", width: 14 },
    { header: "Fark (kg)", key: "weight_diff_kg", width: 12 },
    { header: "Fark (%)", key: "weight_diff_pct", width: 12 },
    { header: "Tutar", key: "amount", width: 14 },
    { header: "Para Birimi", key: "currency", width: 10 },
    { header: "İtiraz Durumu", key: "dispute_status_label", width: 18 },
    { header: "Not", key: "notes", width: 28 },
  ];
  sheet.columns = columns;

  const headerRow = sheet.getRow(1);
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: HEADER_TEXT } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BRAND } };
    cell.alignment = { vertical: "middle" };
  });
  headerRow.height = 20;

  for (const row of rows) {
    const pct = row.weight_diff_pct != null ? Number(row.weight_diff_pct) : null;
    const unit = row.invoiced_weight_unit || "";
    const excelRow = sheet.addRow({
      invoice_no: row.invoice_no,
      invoice_reference_no: row.invoice_reference_no || "",
      tracking_number: row.tracking_number,
      ship_date: row.ship_date || "",
      recipient_name: row.recipient_name || "",
      recipient_country: row.recipient_country || "",
      service: row.service || "",
      reference: row.reference || "",
      invoiced_weight_value: row.invoiced_weight_value != null ? Number(row.invoiced_weight_value) : null,
      invoiced_weight_unit: unit,
      invoiced_weight_kg: row.invoiced_weight_kg != null ? Number(row.invoiced_weight_kg) : null,
      actual_weight_invoice_unit: inInvoiceUnit(row.actual_weight_kg, unit),
      actual_weight_kg: row.actual_weight_kg != null ? Number(row.actual_weight_kg) : null,
      actual_total_pieces: row.actual_total_pieces ?? null,
      weight_diff_invoice_unit: inInvoiceUnit(row.weight_diff_kg, unit),
      weight_diff_kg: row.weight_diff_kg != null ? Number(row.weight_diff_kg) : null,
      weight_diff_pct: pct,
      amount: row.amount != null ? Number(row.amount) : null,
      currency: row.currency || "",
      dispute_status_label: disputeStatusLabel(row.dispute_status),
      notes: row.notes || "",
    });

    [
      "invoiced_weight_value",
      "invoiced_weight_kg",
      "actual_weight_invoice_unit",
      "actual_weight_kg",
      "weight_diff_invoice_unit",
      "weight_diff_kg",
    ].forEach((key) => {
      excelRow.getCell(key).numFmt = "#,##0.00";
    });
    excelRow.getCell("weight_diff_pct").numFmt = "#,##0.0\"%\"";
    excelRow.getCell("amount").numFmt = "#,##0.00";

    const fill = severityFill(pct);
    if (fill) {
      const fillColor = Math.abs(pct) >= 20 ? DANGER_SOFT : WARN_SOFT;
      const textColor = Math.abs(pct) >= 20 ? DANGER : WARN;
      ["weight_diff_invoice_unit", "weight_diff_kg", "weight_diff_pct"].forEach((key) => {
        excelRow.getCell(key).fill = { type: "pattern", pattern: "solid", fgColor: { argb: fillColor } };
        excelRow.getCell(key).font = { color: { argb: textColor }, bold: true };
      });
      void BRAND_SOFT; // (reserved for a future "actioned" row tint - not used yet)
    }
  }

  sheet.autoFilter = { from: "A1", to: `${sheet.getColumn(columns.length).letter}1` };

  return wb.xlsx.writeBuffer();
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function formatDateTime(d) {
  const date = d || new Date();
  return date.toLocaleString("tr-TR", { timeZone: "Europe/Istanbul" });
}
