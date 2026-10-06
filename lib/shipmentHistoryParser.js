// Parses a FedEx Ship Manager "Ship History" export (fedex.com -> Ship
// History tab -> export as .xlsx) into one record per shipment. Runs in the
// BROWSER (see app/shipment-history/page.js) - same reasoning as
// lib/pdfParser.js: this export can be a large file (thousands of rows,
// years of history) and only the small parsed result needs to reach the
// server, not the raw workbook.
//
// Shape of the export, confirmed against a real file
// (Shipment_Report_*.xlsx, ~5100 rows / 67 columns):
//   - One row per PIECE, not per shipment. A multi-piece shipment has
//     several consecutive rows sharing the same masterTrackingNumber (and
//     the same status), each with its own pieceTrackingNumber.
//   - totalShipmentWeight (the shipment-level total the user asked us to
//     compare against FedEx's real weight) is populated on ONLY the FIRST
//     row of each masterTrackingNumber group - every other piece row in
//     that group has it blank. Confirmed exhaustively against the sample
//     file: every one of its 2534 groups had the value on exactly the
//     first row, never split across rows, never duplicated.
//   - status is 'ALL_DOCS_PRINTED' for a shipment that was actually
//     created/labeled, or one of NOT_PRINTED/INCOMPLETE/EXPIRED for a
//     failed/abandoned Ship Manager attempt (no real FedEx shipment exists
//     for those - excluded here rather than compared against Track API,
//     which would correctly find nothing for them anyway).
import ExcelJS from "exceljs";
import { toKg } from "./weightUtils.js";

const REQUIRED_COLUMNS = [
  "masterTrackingNumber",
  "totalShipmentWeight",
  "weightUnits",
  "status",
  "shipDate",
  "reference",
  "numberOfPackages",
];

export async function parseShipmentHistoryXlsx(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets[0];
  if (!ws) {
    throw new Error("Excel dosyasında sayfa bulunamadı.");
  }

  const headerRow = ws.getRow(1);
  const colIndex = {};
  headerRow.eachCell((cell, colNumber) => {
    const key = String(cell.value || "").trim();
    if (key) colIndex[key] = colNumber;
  });

  const missing = REQUIRED_COLUMNS.filter((k) => !colIndex[k]);
  if (missing.length) {
    throw new Error(
      `Beklenen sütunlar bulunamadı (${missing.join(", ")}) - bu dosya FedEx Ship History raporu formatında olmayabilir.`
    );
  }

  // Group per-piece rows by masterTrackingNumber, in file order.
  const groups = new Map();
  const totalRowCount = ws.rowCount;
  for (let r = 2; r <= totalRowCount; r++) {
    const row = ws.getRow(r);
    const mtnRaw = row.getCell(colIndex.masterTrackingNumber).value;
    const mtn = mtnRaw == null ? "" : String(mtnRaw).trim();
    if (!mtn) continue;
    if (!groups.has(mtn)) groups.set(mtn, []);
    groups.get(mtn).push({
      totalShipmentWeight: row.getCell(colIndex.totalShipmentWeight).value,
      weightUnits: row.getCell(colIndex.weightUnits).value,
      status: row.getCell(colIndex.status).value,
      shipDate: row.getCell(colIndex.shipDate).value,
      reference: row.getCell(colIndex.reference).value,
      numberOfPackages: row.getCell(colIndex.numberOfPackages).value,
    });
  }

  const records = [];
  let skippedNotPrinted = 0;
  let skippedNoWeight = 0;
  let skippedUnknownUnit = 0;

  for (const [mtn, rows] of groups) {
    const status = String(rows[0].status || "").trim();
    if (status !== "ALL_DOCS_PRINTED") {
      skippedNotPrinted++;
      continue;
    }

    const weightRow = rows.find((r) => r.totalShipmentWeight != null && r.totalShipmentWeight !== "");
    if (!weightRow) {
      skippedNoWeight++;
      continue;
    }
    const totalShipmentWeight = parseFloat(weightRow.totalShipmentWeight);
    if (!Number.isFinite(totalShipmentWeight)) {
      skippedNoWeight++;
      continue;
    }

    const rawUnit = String(weightRow.weightUnits || "").trim().toUpperCase();
    const unit = rawUnit === "KGS" || rawUnit === "KG" ? "KG" : rawUnit === "LBS" || rawUnit === "LB" ? "LB" : null;
    const totalShipmentWeightKg = unit ? toKg(totalShipmentWeight, unit) : null;
    if (!unit) skippedUnknownUnit++;

    records.push({
      masterTrackingNumber: mtn,
      shipDate: normalizeDate(weightRow.shipDate),
      reference: weightRow.reference != null ? String(weightRow.reference) : null,
      numberOfPackages: parseInt(weightRow.numberOfPackages, 10) || rows.length,
      totalShipmentWeight,
      weightUnit: rawUnit || null,
      totalShipmentWeightKg,
      status,
    });
  }

  return {
    records,
    totalRowsSeen: totalRowCount - 1,
    totalShipmentsSeen: groups.size,
    skippedNotPrinted,
    skippedNoWeight,
    skippedUnknownUnit,
  };
}

function normalizeDate(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}
