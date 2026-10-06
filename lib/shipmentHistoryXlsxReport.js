// Single-sheet Excel export for one category of the "Gönderi Geçmişi
// Karşılaştırma" module (see lib/shipmentHistoryQueries.js) - styled to
// match the same brand color language as lib/xlsxReport.js (the invoice
// report) so every export in this app reads as one system.
import ExcelJS from "exceljs";
import { categoryLabel } from "./shipmentHistoryQueries.js";

const BRAND = "FF006CE0";
const DANGER = "FFD13212";
const DANGER_SOFT = "FFFDF3F1";
const HEADER_TEXT = "FFFFFFFF";
const MUTED = "FF6B7280";

const COLUMN_SETS = {
  all: [
    { header: "Takip No", key: "master_tracking_number", width: 18 },
    { header: "Tarih", key: "ship_date", width: 14 },
    { header: "Referans", key: "reference", width: 14 },
    { header: "Ship History Ağırlığı (kg)", key: "total_shipment_weight_kg", width: 20 },
    { header: "FedEx Gerçek (kg)", key: "actual_weight_kg", width: 16 },
    { header: "Fatura No", key: "invoice_no", width: 18 },
    { header: "Durum", key: "status_label", width: 22 },
  ],
  same: [
    { header: "Takip No", key: "master_tracking_number", width: 18 },
    { header: "Tarih", key: "ship_date", width: 14 },
    { header: "Referans", key: "reference", width: 14 },
    { header: "Fatura No", key: "invoice_no", width: 18 },
    { header: "Ship History Ağırlığı (kg)", key: "total_shipment_weight_kg", width: 20 },
    { header: "FedEx Gerçek (kg)", key: "actual_weight_kg", width: 16 },
  ],
  different: [
    { header: "Takip No", key: "master_tracking_number", width: 18 },
    { header: "Tarih", key: "ship_date", width: 14 },
    { header: "Referans", key: "reference", width: 14 },
    { header: "Fatura No", key: "invoice_no", width: 18 },
    { header: "Ship History Ağırlığı (kg)", key: "total_shipment_weight_kg", width: 20 },
    { header: "FedEx Gerçek (kg)", key: "actual_weight_kg", width: 16 },
    { header: "Fark (kg)", key: "diff_kg", width: 12 },
  ],
  notYetTracked: [
    { header: "Takip No", key: "master_tracking_number", width: 18 },
    { header: "Tarih", key: "ship_date", width: 14 },
    { header: "Referans", key: "reference", width: 14 },
    { header: "Ship History Ağırlığı (kg)", key: "total_shipment_weight_kg", width: 20 },
    { header: "Durum", key: "status_label", width: 26 },
  ],
  fedexOnly: [
    { header: "Takip No", key: "master_tracking_number", width: 18 },
    { header: "Tarih", key: "ship_date", width: 14 },
    { header: "Fatura No", key: "invoice_no", width: 18 },
    { header: "Fatura Ref.", key: "invoice_reference_no", width: 14 },
    { header: "FedEx Gerçek (kg)", key: "actual_weight_kg", width: 16 },
  ],
};

export async function buildShipmentHistoryXlsx(category, rows, { generatedAt } = {}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Coolart Tekstil - FedEx Ağırlık Kontrolü";
  wb.created = generatedAt || new Date(0);

  const sheet = wb.addWorksheet("Gönderiler", { views: [{ state: "frozen", ySplit: 4 }] });

  sheet.mergeCells("A1:D1");
  sheet.getCell("A1").value = `Gönderi Geçmişi Karşılaştırma — ${categoryLabel(category)}`;
  sheet.getCell("A1").font = { size: 15, bold: true, color: { argb: BRAND } };
  sheet.getRow(1).height = 24;
  sheet.getCell("A2").value = `Oluşturulma: ${formatDateTime(generatedAt)}   ·   Toplam: ${rows.length} gönderi`;
  sheet.getCell("A2").font = { italic: true, color: { argb: MUTED } };

  const columns = COLUMN_SETS[category] || COLUMN_SETS.all;
  // Row 4 holds the real headers (rows 1-2 are the title block above) -
  // exceljs's `sheet.columns` writes headers to row 1, so set widths only
  // here and add the header row by hand at r=4.
  sheet.columns = columns.map((c) => ({ key: c.key, width: c.width }));
  const headerRow = sheet.getRow(4);
  columns.forEach((c, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = c.header;
    cell.font = { bold: true, color: { argb: HEADER_TEXT } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BRAND } };
    cell.alignment = { vertical: "middle" };
  });
  headerRow.height = 20;
  sheet.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4, column: columns.length } };

  for (const row of rows) {
    const excelRow = sheet.addRow(buildRowValues(category, row));
    for (const c of columns) {
      if (["total_shipment_weight_kg", "actual_weight_kg", "diff_kg"].includes(c.key)) {
        excelRow.getCell(c.key).numFmt = "#,##0.00";
      }
    }
    if (category === "different") {
      excelRow.eachCell((cell) => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: DANGER_SOFT } };
      });
      excelRow.getCell("diff_kg").font = { color: { argb: DANGER }, bold: true };
    }
  }

  const bytes = await wb.xlsx.writeBuffer();
  return Buffer.from(bytes);
}

function buildRowValues(category, row) {
  const base = {
    master_tracking_number: row.master_tracking_number,
    ship_date: row.ship_date || "",
    reference: row.reference || "",
    invoice_no: row.invoice_no || "",
    invoice_reference_no: row.invoice_reference_no || "",
    total_shipment_weight_kg: row.total_shipment_weight_kg != null ? Number(row.total_shipment_weight_kg) : null,
    actual_weight_kg: row.actual_weight_kg != null ? Number(row.actual_weight_kg) : null,
    diff_kg: row.diff_kg != null ? Number(row.diff_kg) : null,
  };
  if (category === "all") {
    base.status_label =
      row.diff_kg == null
        ? row.has_invoice_line
          ? "Faturalı, senkron bekliyor"
          : "Fatura yüklenmedi"
        : row.diff_kg > 0.1
          ? "Farklı"
          : "Aynı";
  }
  if (category === "notYetTracked") {
    base.status_label = row.has_invoice_line ? "Faturalı, senkron bekliyor" : "Fatura yüklenmedi";
  }
  return base;
}

function formatDateTime(d) {
  const date = d || new Date();
  return date.toLocaleString("tr-TR");
}
