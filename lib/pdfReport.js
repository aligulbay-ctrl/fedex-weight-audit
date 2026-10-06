// Formatted, printable/shareable PDF report for weight-discrepancy
// shipments - landscape A4, a title + summary block on the first page, then
// a paginated table of every matching shipment. Built with pdf-lib (no
// headless-browser dependency, so it works the same in any Node.js
// serverless runtime) using an embedded DejaVu Sans font, since pdf-lib's
// built-in standard fonts cannot encode Turkish characters like İ/ı/ğ/ş.
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import fs from "node:fs";
import path from "node:path";
import { disputeStatusLabel } from "./statusLabels.js";
import { reportFilterLabel } from "./reportData.js";
import { formatWeightInInvoiceUnit, formatDiffInInvoiceUnit } from "./weightUtils.js";

const PAGE_W = 841.89; // A4 landscape
const PAGE_H = 595.28;
const MARGIN = 36;

const BRAND = rgb(0x00 / 255, 0x6c / 255, 0xe0 / 255);
const DANGER = rgb(0xd1 / 255, 0x32 / 255, 0x12 / 255);
const DANGER_SOFT = rgb(0xfd / 255, 0xf3 / 255, 0xf1 / 255);
const WARN = rgb(0xe7 / 255, 0x76 / 255, 0x00 / 255);
const WARN_SOFT = rgb(0xff / 255, 0xf1 / 255, 0xe0 / 255);
const MUTED = rgb(0x6b / 255, 0x72 / 255, 0x80 / 255);
const INK = rgb(0.1, 0.1, 0.12);
const WHITE = rgb(1, 1, 1);
const HEADER_BG = BRAND;
const ROW_BORDER = rgb(0.88, 0.89, 0.91);

// Widths sized from the real embedded-font metrics of both the header
// labels and representative worst-case body values (see the width-tuning
// note in drawTableRow) so nothing needs to truncate in the common case;
// truncateToWidth() is still applied to every cell as a safety net for the
// rare longer value (e.g. an unusually long recipient name).
const COLUMNS = [
  { key: "tracking_number", label: "Takip No", width: 64 },
  { key: "invoice_no", label: "Fatura No", width: 80 },
  { key: "invoice_reference_no", label: "Fatura Ref.", width: 56 },
  { key: "recipient_name", label: "Alıcı", width: 90 },
  { key: "recipient_country", label: "Ülke", width: 58 },
  { key: "invoiced_weight_display", label: "Fatura Ağırlığı", width: 70 },
  { key: "actual_weight_display", label: "FedEx Gerçek", width: 76 },
  { key: "diff_display", label: "Fark", width: 44 },
  { key: "diff_pct_display", label: "Fark (%)", width: 46 },
  { key: "amount_display", label: "Tutar", width: 52 },
  { key: "status_label", label: "İtiraz Durumu", width: 82 },
];

const TABLE_W = COLUMNS.reduce((s, c) => s + c.width, 0);
const ROW_H = 16;
const HEADER_H = 20;

export async function buildDiscrepancyPdfBuffer(rows, summary, { only, generatedAt, fedexMinDisputeKg } = {}) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);

  const regularBytes = fs.readFileSync(path.join(process.cwd(), "assets", "fonts", "DejaVuSans.ttf"));
  const boldBytes = fs.readFileSync(path.join(process.cwd(), "assets", "fonts", "DejaVuSans-Bold.ttf"));
  const font = await doc.embedFont(regularBytes, { subset: true });
  const bold = await doc.embedFont(boldBytes, { subset: true });
  // Fallback kept available in case a glyph the embedded set doesn't cover
  // ever shows up (shouldn't, for Turkish/Latin text) - unused otherwise.
  void StandardFonts;

  const state = { doc, font, bold, page: null, y: 0 };

  addPage(state);
  drawHeader(state, { only, generatedAt, isFirstPage: true, fedexMinDisputeKg });
  drawSummary(state, summary, only);
  drawTableHeader(state);

  for (const row of rows) {
    ensureRoom(state, ROW_H);
    drawTableRow(state, row);
  }

  const bytes = await doc.save();
  return Buffer.from(bytes);
}

function addPage(state) {
  state.page = state.doc.addPage([PAGE_W, PAGE_H]);
  state.y = PAGE_H - MARGIN;
}

function ensureRoom(state, needed) {
  if (state.y - needed < MARGIN) {
    addPage(state);
    drawTableHeader(state);
  }
}

function drawHeader(state, { only, generatedAt, isFirstPage, fedexMinDisputeKg }) {
  const { page, bold, font } = state;
  if (isFirstPage) {
    page.drawText("Coolart Tekstil — FedEx Ağırlık Farkı Raporu", {
      x: MARGIN,
      y: state.y - 18,
      size: 17,
      font: bold,
      color: BRAND,
    });
    state.y -= 30;
    const filterLabel = reportFilterLabel(only, fedexMinDisputeKg);
    page.drawText(`${filterLabel}   ·   Oluşturulma: ${formatDateTime(generatedAt)}`, {
      x: MARGIN,
      y: state.y,
      size: 9,
      font,
      color: MUTED,
    });
    state.y -= 20;
  }
}

function drawSummary(state, summary, only) {
  const { page, bold, font } = state;
  void only;

  const items = [
    ["Toplam gönderi", String(summary.shipmentCount)],
    ["Fatura sayısı", String(summary.invoiceCount)],
    ["Toplam ağırlık farkı", `${round2(summary.totalDiffKg)} kg`],
    ["Ortalama fark", summary.avgDiffPct != null ? `%${round2(summary.avgDiffPct)}` : "—"],
    ["Henüz işaretlenmemiş", String(summary.notActioned)],
  ];

  const boxW = TABLE_W;
  const boxH = 34;
  page.drawRectangle({
    x: MARGIN,
    y: state.y - boxH,
    width: boxW,
    height: boxH,
    color: rgb(0.973, 0.98, 0.996),
    borderColor: ROW_BORDER,
    borderWidth: 1,
  });

  const colW = boxW / items.length;
  items.forEach(([label, value], i) => {
    const x = MARGIN + i * colW + 10;
    page.drawText(label, { x, y: state.y - 14, size: 7.5, font, color: MUTED });
    page.drawText(value, { x, y: state.y - 27, size: 11, font: bold, color: INK });
  });

  state.y -= boxH + 16;
}

function drawTableHeader(state) {
  const { page, bold } = state;
  let x = MARGIN;
  page.drawRectangle({ x: MARGIN, y: state.y - HEADER_H, width: TABLE_W, height: HEADER_H, color: HEADER_BG });
  for (const col of COLUMNS) {
    // Truncated defensively (not just sized to fit today's labels) so a
    // future label/width tweak can never bleed text into the next column.
    const label = truncateToWidth(bold, col.label, 7.5, col.width - 8);
    page.drawText(label, {
      x: x + 4,
      y: state.y - HEADER_H + 6,
      size: 7.5,
      font: bold,
      color: WHITE,
    });
    x += col.width;
  }
  state.y -= HEADER_H;
}

function drawTableRow(state, row) {
  const { page, font } = state;
  const pct = row.weight_diff_pct != null ? Number(row.weight_diff_pct) : null;
  const severity = pct == null ? null : Math.abs(pct) >= 20 ? "danger" : Math.abs(pct) >= 10 ? "warn" : null;

  const cells = {
    tracking_number: row.tracking_number || "",
    invoice_no: row.invoice_no || "",
    invoice_reference_no: row.invoice_reference_no || "",
    recipient_name: row.recipient_name || "",
    recipient_country: row.recipient_country || "",
    invoiced_weight_display: `${fmtNum(row.invoiced_weight_value)} ${row.invoiced_weight_unit || ""}`.trim(),
    // Same unit-matching helpers the dashboard uses: an LB-invoiced row
    // shows the FedEx/fark weight converted to LB (kg alongside), a
    // KG-invoiced row just shows kg - never a unit the invoice didn't use.
    actual_weight_display: formatWeightInInvoiceUnit(row.actual_weight_kg, row.invoiced_weight_unit),
    diff_display: formatDiffInInvoiceUnit(row.weight_diff_kg, row.invoiced_weight_unit),
    diff_pct_display: pct != null ? `%${fmtNum(pct)}` : "—",
    amount_display: row.amount != null ? `${fmtNum(row.amount)} ${row.currency || ""}`.trim() : "—",
    status_label: disputeStatusLabel(row.dispute_status),
  };

  if (severity) {
    page.drawRectangle({
      x: MARGIN,
      y: state.y - ROW_H,
      width: TABLE_W,
      height: ROW_H,
      color: severity === "danger" ? DANGER_SOFT : WARN_SOFT,
    });
  }
  page.drawRectangle({
    x: MARGIN,
    y: state.y - ROW_H,
    width: TABLE_W,
    height: ROW_H,
    borderColor: ROW_BORDER,
    borderWidth: 0.5,
  });

  let x = MARGIN;
  for (const col of COLUMNS) {
    const raw = String(cells[col.key] ?? "");
    const color = severity && (col.key === "diff_display" || col.key === "diff_pct_display")
      ? severity === "danger" ? DANGER : WARN
      : INK;
    const text = truncateToWidth(font, raw, 7, col.width - 8);
    page.drawText(text, { x: x + 4, y: state.y - ROW_H + 5, size: 7, font, color });
    x += col.width;
  }
  state.y -= ROW_H;
}

function truncateToWidth(font, text, size, maxWidth) {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = text.slice(0, mid) + "…";
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return lo <= 0 ? "" : text.slice(0, lo) + "…";
}

function fmtNum(n) {
  if (n == null) return "";
  return Number(n).toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function formatDateTime(d) {
  const date = d || new Date();
  return date.toLocaleString("tr-TR", { timeZone: "Europe/Istanbul" });
}
