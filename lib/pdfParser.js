import { extractText, getDocumentProxy } from "unpdf";
import { parseTrNumber, toKg, normalizeWeightUnit } from "./weightUtils.js";

// FedEx Turkey e-Fatura shipment invoices render as one shipment "block" per
// row, in this order (confirmed against a real invoice PDF's extracted text):
//
//   <rowNo> <shipDate DD-MM-YYYY>
//   <trackingNumber>
//   Gönderen: ...
//   İsim: ...
//   Adres: ...
//   Ülke: Turkey
//   Alıcı: <recipient name>            (sometimes an extra "İsim:" line, e.g. RMA/return labels)
//   Adres: <recipient address>
//   Ülke:<recipient country>
//   Teslimat Tarihi: DD-MM-YYYY
//   <Service> [<reference>] <weight><space><KG|LB> <amount> TL
//
// This parser is line/regex based rather than tied to visual PDF layout, so
// it keeps working even if column widths or wrapping change between PDF
// exports - as long as the label text (Alıcı:, Ülke:, Teslimat Tarihi:, TL)
// stays the same. If FedEx changes the invoice template, `rows.length === 0`
// below is the signal something broke - surface that to the user rather
// than silently importing zero shipments.

const HEADER_RE = /^(\d{1,4})\s+(\d{2}-\d{2}-\d{4})\s*$/;
const TRACKING_RE = /^(\d{9,15})\s*$/;

// unpdf's text extraction occasionally runs a tracking-number line straight
// into the next field with no line break, e.g.
// "870571273142 Alıcı: NIKKO HOLZ" instead of the usual two separate lines
// - confirmed against a real invoice where this happened for exactly one
// shipment out of dozens. Left alone, that merged line fails TRACKING_RE
// (which requires the line to be *only* the tracking number), so the row
// boundary detection below never recognizes that shipment as starting a
// new block - its lines get silently absorbed into the PRECEDING
// shipment's block instead, and because parseBlock() below keeps
// overwriting weight/service/amount for every "FedEx ... TL" line it sees
// in a block, the wrong shipment's weight would win. Splitting any such
// merged line back into two lines up front (tracking number alone, then
// whatever followed it) restores the normal one-line-per-field shape
// before any block splitting happens, so every other rule below just works.
//
// The trailing text is required to start with a recognized field label
// (rather than matching ANY trailing text) - a 9-15 digit number can
// legitimately appear mid-line for an unrelated reason, e.g. an "OLD
// TRCK#" reference wrapped onto its own line ahead of the actual
// weight/amount ("870975705425 40 LB 13.159,13 TL" - a real case seen in
// production). Matching any digits+text there would wrongly split that
// into "870975705425" (which then reads as a structural line boundary,
// see isStructuralLine below) + "40 LB 13.159,13 TL", breaking the
// multi-line service-wrap merge in mergeWrappedServiceLines() below
// before it ever gets a chance to run.
const TRACKING_WITH_TRAILING_TEXT_RE = /^(\d{9,15})\s+((?:Alıcı|Gönderen|İsim|Adres|Ülke|Teslimat Tarihi):.*)$/;

// Two more unpdf line-reflow quirks, both confirmed against real invoices
// where they caused a shipment's weight to come back completely missing
// (invoiced_weight_kg NULL) even though the PDF clearly shows a weight for
// that row - see lib/weightUtils.js's evaluateDiscrepancy comment for the
// downstream bug this class of gap eventually caused (NaN kg on sync).
//
// 1) The recipient name and the service/weight/amount line run together on
//    ONE line with no break, e.g.
//      "Alıcı: FERNANDA MEZA FedEx Intl Priority 9485844 13,3 LB 1.115,93 TL"
//    Seen specifically on the LAST shipment row of an invoice (its
//    Adres:/Ülke:/Teslimat Tarihi: lines also end up reordered, after the
//    invoice's totals block - harmless here since parseBlock()'s field
//    guards below don't depend on line order, only on recipientName being
//    set first). Left alone, the whole line matches "Alıcı:" and its
//    entire tail - name AND the FedEx/weight/amount data - gets swallowed
//    into recipientName, and the service/weight regex never even sees it.
// The known FedEx service-name "roots" that can start a service line -
// this is the SINGLE SOURCE OF TRUTH for what counts as a recognized
// service name. ALICI_WITH_SERVICE_RE just below, SERVICE_NAME_RE further
// down, and the fold-trigger in mergeWrappedServiceLines() all build off
// this same string, instead of each hardcoding its own copy of "FedEx" or
// "Economy Service" separately. A real gap found in production: the
// Alıcı-merge splitter above was only ever taught about "FedEx", so a
// real invoice line like "Alıcı: JOHN SEO Economy Service 0547430 4,4 KG
// 855,53 TL" (recipient name merged with an "Economy Service" line) sailed
// straight through with its weight silently lost, even though
// SERVICE_NAME_RE already knew about "Economy Service" for the *unmerged*
// case. Adding a new service-name root here now covers all three call
// sites in one edit instead of three.
const SERVICE_NAME_ROOTS_SRC =
  "FedEx(?:\\s+(?:International|Intl|Ground|Home|Express|Economy|Priority|Standard|Overnight|Saver|Freight|Connect|Plus|First|SmartPost|Delivery|\\d+\\s?Day))+|Economy Service";

// Anchored on SERVICE_NAME_ROOTS_SRC (rather than a free-form "ends in
// weight+unit+amount+TL" match) because recipient names are themselves
// unconstrained free text - without a known service-name anchor to mark
// where the name ends and the service begins, there's no reliable place
// to cut the line (e.g. "ROCKY JAMES MARCHESE Economy Service ..." could
// otherwise be cut after "ROCKY" just as validly as after "MARCHESE").
// This does mean an entirely new, never-before-seen service-name root
// merged this way would still slip through undetected - if that happens,
// add the new root to SERVICE_NAME_ROOTS_SRC above (one edit, not three)
// rather than patching this regex directly.
const ALICI_WITH_SERVICE_RE = new RegExp(
  `^(Alıcı:\\s*.+?)\\s+((?:${SERVICE_NAME_ROOTS_SRC})\\b.*TL)\\s*$`,
  "i"
);

// 2) The service/reference/weight/amount line wraps across two (sometimes
//    more) text lines - either mid-reference for a multi-piece shipment
//    with several piece numbers ("FedEx Intl Priority 8346601 2xW35" /
//    "3xW31 37,2 LB 4.239,60 TL"), or mid service-name ("FedEx Express" /
//    "Saver 870351493543 40 LB 22.087,56 TL"). Either way the line
//    starting with a known service-name root doesn't end in "TL" by
//    itself, so SERVICE_LINE_RE never matches it (or the continuation
//    line, which doesn't start with a service-name root either).
//
// 3) unpdf's line-reflow bug isn't limited to the two spots above (a
//    tracking number glued to the next field, or Alıcı glued to a service
//    line) - a real invoice was found where the service/weight/amount
//    line's trailing "TL" runs straight into the NEXT field label with
//    zero space in between, e.g. "...967,34 TLTeslimat Tarihi:
//    29-06-2026" or "...874,02 TLÜlke:United States". Rather than adding
//    a third hardcoded pattern for this specific pair of fields,
//    splitEmbeddedFieldLabels() below splits at ANY recognized field
//    label found mid-line (not just at the very start of a line), closing
//    this whole class of "two fields glued together with no line break"
//    bug in one place instead of one specific pair of fields at a time.
const FIELD_LABEL_ALTERNATION = "Gönderen:|İsim:|Adres:|Ülke:|Alıcı:|Teslimat Tarihi:";
const STARTS_WITH_FIELD_LABEL_RE = new RegExp(`^(?:${FIELD_LABEL_ALTERNATION})`);
const EMBEDDED_FIELD_LABEL_RE = new RegExp(`^(.+?)(${FIELD_LABEL_ALTERNATION})(.*)$`);

// Used by mergeWrappedServiceLines() below to spot a service line that's
// about to wrap - built off the same SERVICE_NAME_ROOTS_SRC as everything
// else above, so a wrap starting with "Economy Service" (or any future
// root added there) folds forward exactly like a "FedEx ..." wrap does,
// instead of only ever recognizing "FedEx" as a possible wrap start.
const SERVICE_LINE_START_RE = new RegExp(`^(?:${SERVICE_NAME_ROOTS_SRC})\\b`, "i");

function isStructuralLine(line) {
  return (
    HEADER_RE.test(line) ||
    TRACKING_RE.test(line) ||
    /^Gönderen:/.test(line) ||
    /^İsim:/.test(line) ||
    /^Adres:/.test(line) ||
    /^Ülke:/i.test(line) ||
    /^Alıcı:/.test(line) ||
    /^Teslimat Tarihi:/.test(line)
  );
}

// The service+reference+weight+amount all land on one text line, e.g.
// "FedEx Intl Priority 0195428 8 KG 1.385,58 TL" for a domestic/kg-billed
// shipment, or "...27,1 LBS 1.385,58 TL" for a pound-billed one (FedEx
// bills some international/US-bound shipments in lbs even on a Turkish
// invoice). There's no reliable separator between "service name" and the
// optional reference that precedes it - both are just space-separated -
// so this regex only peels off the weight/unit/amount/TL tail (anchored
// to end-of-line, which resolves the ambiguity: reference text is never
// itself a valid "<digits> <unit> <digits> TL" tail). Splitting "service"
// from "reference" within the remaining left-hand blob happens separately
// below via SERVICE_NAME_RE.
//
// The unit itself is captured loosely (2-4 letters, optional trailing
// period) rather than a hardcoded "KG|LB", then validated/normalized via
// normalizeWeightUnit() below - this way "KGS", "LBS", "Kg." etc. are all
// recognized instead of silently falling through to "no match" (which
// would previously have failed to match the whole line, and could ONLY
// happen for the unit format actually printed - use the exact literal
// "KG"/"LB" spelling here at your peril, real invoices vary).
//
// The left-hand "service name" segment is intentionally NOT anchored to a
// literal "FedEx" prefix (it originally was) - a real invoice line was
// found printed as "Economy Service 871743703873 MA 7,9 LB 827,30 TL",
// with no "FedEx" at all. Anything ending in "<weight> <unit> <amount> TL"
// is accepted; this stays safe against false positives on the invoice's
// own summary/total lines ("Vergiler Dahil Toplam Tutar: 93.627,13 TL"
// etc.) purely because those only ever have ONE number before "TL", never
// the "<number> <letters> <number> TL" shape a real weight/amount line has
// - verified empirically against every non-shipment "...TL" line in the
// sample invoices this was debugged against.
const SERVICE_LINE_RE = /^(.+?)\s+([\d.,]+)\s*([A-Za-z]{2,4})\.?\s+([\d.,]+)\s*TL\s*$/i;

// Used to peel "FedEx Intl Priority" (or the "Economy Service" variant
// seen without a "FedEx" prefix - see SERVICE_LINE_RE above) off the front
// of the left segment above so whatever remains (a customer reference /
// order number, e.g. "0195428" or "7836218 -1-1") isn't swallowed into the
// service name. Falls back gracefully (whole segment kept as the service,
// no reference) for a service phrase not in SERVICE_NAME_ROOTS_SRC (see
// its definition above ALICI_WITH_SERVICE_RE - shared with this regex).
const SERVICE_NAME_RE = new RegExp(`^(${SERVICE_NAME_ROOTS_SRC})\\b\\s*(.*)$`, "i");

const COUNTRY_RE = /^Ülke:\s*(.+)$/;

export async function parseFedexInvoicePdf(buffer) {
  // unpdf wraps a serverless/edge-friendly build of pdf.js (no filesystem
  // assets, no worker thread) - pdf-parse's default pdfjs-dist build was
  // tried first but failed to load on Vercel's Node serverless runtime.
  // unpdf/pdf.js reject a Node Buffer even though Buffer extends Uint8Array
  // (it checks the concrete constructor) - always copy into a plain Uint8Array.
  const data = new Uint8Array(buffer);
  const doc = await getDocumentProxy(data);
  const { text: rawText } = await extractText(doc, { mergePages: true });
  const rawLines = rawText.split("\n").map((l) => l.replace(/\r$/, ""));
  const lines = mergeWrappedServiceLines(
    splitMergedAliciServiceLines(normalizeTrackingLines(splitEmbeddedFieldLabels(rawLines)))
  );

  const meta = parseInvoiceMeta(lines);
  const rows = parseShipmentRows(lines);

  return { meta, rows, rawTextLineCount: lines.length };
}

// See point 3) in the comment above ALICI_WITH_SERVICE_RE - splits any
// line where a recognized field label appears somewhere OTHER than the
// very start (i.e. glued onto the end of whatever text came before it,
// with no line break) back into two lines. Runs first, ahead of every
// other normalization pass below, since it's the most general of the
// line-reflow fixes here and the others narrow the search space it needs
// to consider (e.g. normalizeTrackingLines' own case - a tracking number
// glued to "Alıcı:" - is a special case of this same pattern and would be
// caught here too, but is left in place afterwards as a second, more
// specific safety net).
function splitEmbeddedFieldLabels(lines) {
  const out = [];
  for (const line of lines) {
    if (STARTS_WITH_FIELD_LABEL_RE.test(line)) {
      out.push(line);
      continue;
    }
    const m = line.match(EMBEDDED_FIELD_LABEL_RE);
    if (m && m[1].trim()) {
      out.push(m[1].trim());
      out.push((m[2] + m[3]).trim());
    } else {
      out.push(line);
    }
  }
  return out;
}

// See TRACKING_WITH_TRAILING_TEXT_RE above - splits a merged
// "<trackingNumber> <next field>" line back into two lines so every
// downstream regex sees the one-line-per-field shape it expects.
function normalizeTrackingLines(lines) {
  const out = [];
  for (const line of lines) {
    const m = line.match(TRACKING_WITH_TRAILING_TEXT_RE);
    if (m) {
      out.push(m[1]);
      out.push(m[2]);
    } else {
      out.push(line);
    }
  }
  return out;
}

// See ALICI_WITH_SERVICE_RE above - splits "Alıcı: <name> FedEx ... TL"
// back into two lines ("Alıcı: <name>" and the FedEx/weight/amount line)
// so the two fields get extracted independently, same as
// normalizeTrackingLines does for the merged-tracking-number case.
function splitMergedAliciServiceLines(lines) {
  const out = [];
  for (const line of lines) {
    const m = line.match(ALICI_WITH_SERVICE_RE);
    if (m) {
      out.push(m[1].trim());
      out.push(m[2].trim());
    } else {
      out.push(line);
    }
  }
  return out;
}

// See the wrapped-service-line note above ALICI_WITH_SERVICE_RE - folds a
// service line (starting with a known SERVICE_NAME_ROOTS_SRC root) that
// doesn't yet end in "TL" forward into whichever following line(s)
// complete it, stopping as soon as a line ending in "TL" is found
// (success) or a clearly-structural line/row boundary is hit (give up -
// leave the original lines alone rather than guess, same "never guess
// wrong" rule as evaluateDiscrepancy/extractActualWeightKg elsewhere).
// The 3-line fold cap is generous for what's actually been seen (one
// extra line) while still bailing out of a genuinely missing weight
// quickly instead of swallowing unrelated rows.
function mergeWrappedServiceLines(lines) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (SERVICE_LINE_START_RE.test(line.trim()) && !/TL\s*$/i.test(line.trim())) {
      let merged = line.trim();
      let end = i;
      let ok = false;
      for (let k = i + 1; k < lines.length && k - i <= 3; k++) {
        const next = lines[k].trim();
        if (isStructuralLine(next)) break;
        merged = `${merged} ${next}`;
        end = k;
        if (/TL\s*$/i.test(next)) { ok = true; break; }
      }
      if (ok) {
        out.push(merged);
        i = end + 1;
        continue;
      }
    }
    out.push(line);
    i++;
  }
  return out;
}

function parseInvoiceMeta(lines) {
  const text = lines.join("\n");
  const get = (re) => {
    const m = text.match(re);
    return m ? m[1].trim() : null;
  };
  return {
    invoiceNo: get(/Fatura No:\s*\t?\s*(\S+)/),
    invoiceDate: toIso(get(/(?:^|\n)Tarih:\s*\t?\s*(\d{2}-\d{2}-\d{4})/)),
    dueDate: toIso(get(/Son Ödeme Tarihi:\s*\t?\s*(\d{2}-\d{2}-\d{4})/)),
    customerName: get(/SAYIN\s*\n+\s*([^\n]+)/) || get(/\n([A-ZÇĞİÖŞÜ0-9 .,]+LTD[^\n]*)\n/),
    totalAmount: parseTrNumber(get(/Ödenecek Tutar:\s*\t?\s*([\d.,]+)\s*TL/)),
    // The e-Fatura header's own "Referans No:" field (e.g. "508536319") -
    // this is a single invoice-level reference number issued by the
    // Turkish e-Fatura system, separate from both the FedEx invoice number
    // above and the per-shipment "Servis Referans" captured on each row
    // in parseShipmentRows() below. "No:" (not "Tarihi:") anchors this so
    // it doesn't also match the very next line, "Referans Tarihi:".
    referenceNo: get(/Referans No:\s*\t?\s*(\S+)/),
  };
}

function parseShipmentRows(lines) {
  // Find each row's start index (row number + ship date on one line).
  const starts = [];
  lines.forEach((line, idx) => {
    if (HEADER_RE.test(line) && TRACKING_RE.test(lines[idx + 1] || "")) {
      starts.push(idx);
    }
  });

  const rows = [];
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i];
    const to = i + 1 < starts.length ? starts[i + 1] : lines.length;
    const block = lines.slice(from, to);
    const parsed = parseBlock(block);
    if (parsed) rows.push(parsed);
  }
  return rows;
}

function parseBlock(block) {
  const headerMatch = block[0].match(HEADER_RE);
  const trackingMatch = block[1].match(TRACKING_RE);
  if (!headerMatch || !trackingMatch) return null;

  const rowNo = parseInt(headerMatch[1], 10);
  const shipDate = toIso(headerMatch[2]);
  const trackingNumber = trackingMatch[1];

  // Everything after "Alıcı:" up to the recipient "Adres:" line is the name
  // (usually one line, but keep it flexible for the odd extra "İsim:" line).
  let recipientName = null;
  let recipientAddress = null;
  let recipientCountry = null;
  let deliveryDate = null;
  let service = null;
  let reference = null;
  let weightValue = null;
  let weightUnit = null;
  let amount = null;

  for (let i = 0; i < block.length; i++) {
    const line = block[i].trim();

    // First match wins for every field below (guard on the field still
    // being null) - a block should only ever contain one of each, but if
    // invoice text extraction ever leaks a stray duplicate line into a
    // block (as happened for the merged-tracking-line case above), this
    // stops a later stray line from silently overwriting the correct
    // value instead of the row ending up with a mix of two shipments'
    // data. Consistent with the project's "never guess/overwrite silently"
    // rule (see extractActualWeightKg in fedexClient.js).
    const aliciMatch = line.match(/^Alıcı:\s*(.*)$/);
    if (aliciMatch) {
      if (!recipientName) recipientName = aliciMatch[1].trim();
      continue;
    }

    // The block always contains (at least) two "Ülke:" lines - the
    // sender's (always "Turkey", appears before "Alıcı:") and the
    // recipient's (appears right after "Alıcı:"/"Adres:", before
    // "Teslimat Tarihi:"). Rather than assuming "the last Ülke: line in
    // the block is the recipient's" (which breaks if a stray extra Ülke:
    // line leaks in after the service line - seen in practice, see the
    // merged-tracking-line note above), take the first Ülke: line that
    // appears once we already know we're past the sender block (i.e.
    // recipientName is set) - that's always the recipient's, by the
    // template's own field order, and a first-wins guard means any later
    // stray line can't override it.
    const countryMatch = line.match(COUNTRY_RE);
    if (countryMatch) {
      if (recipientName && !recipientCountry) recipientCountry = countryMatch[1].trim();
      continue;
    }

    if (recipientName && !recipientAddress) {
      const addresMatch = line.match(/^Adres:\s*(.*)$/);
      if (addresMatch) {
        recipientAddress = addresMatch[1].trim();
        continue;
      }
    }

    const deliveryMatch = line.match(/^Teslimat Tarihi:\s*(\d{2}-\d{2}-\d{4})/);
    if (deliveryMatch) {
      if (!deliveryDate) deliveryDate = toIso(deliveryMatch[1]);
      continue;
    }

    const serviceMatch = block[i].match(SERVICE_LINE_RE);
    // Only accept the match if the captured unit is actually a weight unit
    // we recognize (KG/KGS/LB/LBS, any casing/trailing period) - otherwise
    // this line probably wasn't the service/weight/amount line at all, and
    // guessing would be worse than leaving weight null (same "never guess
    // wrong" rule as extractActualWeightKg in fedexClient.js).
    const unitNormalized = serviceMatch ? normalizeWeightUnit(serviceMatch[3]) : null;
    if (serviceMatch && unitNormalized && weightValue == null) {
      const left = serviceMatch[1].trim();
      const nameMatch = left.match(SERVICE_NAME_RE);
      if (nameMatch) {
        service = nameMatch[1].trim();
        reference = nameMatch[2].trim().replace(/\s+/g, " ") || null;
      } else {
        service = left;
        reference = null;
      }
      weightValue = parseTrNumber(serviceMatch[2]);
      weightUnit = unitNormalized;
      amount = parseTrNumber(serviceMatch[4]);
      continue;
    }
  }

  const invoicedWeightKg = toKg(weightValue, weightUnit);

  return {
    rowNo,
    trackingNumber,
    shipDate,
    deliveryDate,
    recipientName,
    recipientAddress,
    recipientCountry,
    service,
    reference,
    invoicedWeightValue: weightValue,
    invoicedWeightUnit: weightUnit,
    invoicedWeightKg,
    amount,
    currency: "TL",
  };
}

function toIso(ddmmyyyy) {
  if (!ddmmyyyy) return null;
  const m = ddmmyyyy.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  return `${yyyy}-${mm}-${dd}`;
}
