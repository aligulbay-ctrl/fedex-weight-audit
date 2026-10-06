#!/usr/bin/env node
// Standing regression check for lib/pdfParser.js.
//
// WHY THIS EXISTS: the invoice weight parser has repeatedly broken on new
// FedEx e-Fatura PDFs because unpdf's text extraction reflows lines in a
// handful of different ways (a tracking number glued to the next field, a
// recipient name glued to a service line, a service line wrapping across
// several lines, a service line glued to the following field...). Every
// prior fix was verified only against whichever 1-3 invoices had just
// caused a complaint, so a fix for invoice N would occasionally regress
// something that had been working since invoice N-3. This script runs the
// REAL parser against every real invoice PDF you point it at and reports
// any shipment with a missing/zero weight, so a future parser change can
// be checked against the FULL accumulated set of real invoices in one
// command instead of by hand, one screenshot at a time.
//
// Usage:
//   node scripts/check-invoices.mjs <folder-with-pdfs> [<folder2> ...]
//   node scripts/check-invoices.mjs invoice.pdf
//
// Before changing lib/pdfParser.js: save every real invoice PDF the app
// has ever been given trouble by into one folder (do NOT commit real
// customer PDFs to the repo - keep that folder outside version control,
// e.g. next to the project rather than inside it), then run this script
// against that folder both BEFORE and AFTER your change and diff the
// output. "0 missing weight" for every file, both times, with an
// unchanged total row count, means the change is safe to ship.

import fs from "node:fs";
import path from "node:path";
import { extractText, getDocumentProxy } from "unpdf";
import { parseFedexInvoicePdf } from "../lib/pdfParser.js";

function collectPdfPaths(inputs) {
  const paths = [];
  for (const p of inputs) {
    const stat = fs.statSync(p);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(p).sort()) {
        if (name.toLowerCase().endsWith(".pdf")) paths.push(path.join(p, name));
      }
    } else if (p.toLowerCase().endsWith(".pdf")) {
      paths.push(p);
    }
  }
  return paths;
}

async function main() {
  const inputs = process.argv.slice(2);
  if (inputs.length === 0) {
    console.error("Usage: node scripts/check-invoices.mjs <folder-with-pdfs|invoice.pdf> [...]");
    process.exit(1);
  }

  const files = collectPdfPaths(inputs);
  if (files.length === 0) {
    console.error("No .pdf files found in the given path(s).");
    process.exit(1);
  }

  let totalRows = 0;
  let totalMissing = 0;
  let filesWithIssues = 0;

  for (const fp of files) {
    const buf = fs.readFileSync(fp);
    let meta, rows;
    try {
      ({ meta, rows } = await parseFedexInvoicePdf(buf));
    } catch (err) {
      console.log(`\n=== ${path.basename(fp)} - FAILED TO PARSE: ${err.message} ===`);
      filesWithIssues++;
      continue;
    }
    const missing = rows.filter((r) => r.invoicedWeightKg == null);
    totalRows += rows.length;
    totalMissing += missing.length;

    if (missing.length === 0 && rows.length > 0) {
      console.log(`OK   ${path.basename(fp)} (${meta.invoiceNo ?? "?"}) - ${rows.length} rows, 0 missing weight`);
      continue;
    }

    filesWithIssues++;
    if (rows.length === 0) {
      console.log(`\n=== ${path.basename(fp)} - 0 ROWS PARSED (invoice template may have changed) ===`);
      continue;
    }

    console.log(`\n=== ${path.basename(fp)} (${meta.invoiceNo ?? "?"}) - ${rows.length} rows, ${missing.length} MISSING WEIGHT ===`);

    // Dump the raw extracted lines around each missing shipment to speed up diagnosis.
    const data = new Uint8Array(buf);
    const doc = await getDocumentProxy(data);
    const { text: rawText } = await extractText(doc, { mergePages: true });
    const rawLines = rawText.split("\n").map((l) => l.replace(/\r$/, ""));

    for (const m of missing) {
      console.log(`  -- tracking ${m.trackingNumber} (row ${m.rowNo}) recipient="${m.recipientName}"`);
      let idx = rawLines.findIndex((l) => l.trim() === m.trackingNumber);
      if (idx === -1) idx = rawLines.findIndex((l) => l.includes(m.trackingNumber));
      if (idx === -1) {
        console.log("     (raw tracking line not found)");
        continue;
      }
      for (let k = Math.max(0, idx - 1); k < Math.min(rawLines.length, idx + 12); k++) {
        console.log(`     [${k}] ${JSON.stringify(rawLines[k])}`);
      }
    }
  }

  console.log(`\nTOTAL: ${files.length} file(s), ${totalRows} rows, ${totalMissing} missing weight, ${filesWithIssues} file(s) with issues`);
  process.exit(totalMissing > 0 || filesWithIssues > 0 ? 1 : 0);
}

main();
