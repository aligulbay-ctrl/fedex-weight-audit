import { ensureSchema, queryDb, apiHandler } from "../../../../lib/db.js";
import { getSettings, markGmailSynced } from "../../../../lib/settings.js";
import {
  gmailConfigured,
  getAccessToken,
  listDisputeMessageIds,
  getMessage,
  getHeader,
  extractMessageText,
  parseDisputeEmail,
  parseFedexDateToIso,
} from "../../../../lib/gmailClient.js";

export const runtime = "nodejs";

// Manual, button-triggered sync (mirrors /api/sync for FedEx weights):
// searches Gmail for "Your dispute record" emails, parses the ones we
// haven't stored yet, and - for any whose Tracking ID matches a shipment
// currently at dispute_status 'none' or 'flagged' - flips that shipment to
// 'disputed' and records the FedEx dispute ref (e.g. "CQL 49134122").
export const POST = apiHandler(async (req) => {
  await ensureSchema();

  if (!(await gmailConfigured())) {
    return Response.json(
      { error: "Gmail bağlı değil (Ayarlar sayfasından 'Gmail ile bağlan')." },
      { status: 400 }
    );
  }

  let body = {};
  try {
    body = await req.json();
  } catch {
    // no body is fine, use defaults
  }
  const maxResults = Math.min(Math.max(parseInt(body.maxResults || "25", 10), 1), 100);

  let accessToken;
  try {
    accessToken = await getAccessToken();
  } catch (err) {
    return Response.json(
      { error: err.message, gmailAuthError: Boolean(err.gmailAuthError) },
      { status: 400 }
    );
  }

  const list = await listDisputeMessageIds(accessToken, { maxResults });
  const messages = list.messages || [];

  let scanned = 0;
  let alreadyKnown = 0;
  let imported = 0;
  let statusUpdated = 0;
  let unmatchedTracking = 0;

  for (const m of messages) {
    scanned++;

    const { rows: existingRows } = await queryDb(
      `SELECT id FROM dispute_emails WHERE gmail_message_id = $1`,
      [m.id]
    );
    if (existingRows[0]) {
      alreadyKnown++;
      continue;
    }

    const full = await getMessage(accessToken, m.id);
    const headers = full.payload?.headers || [];
    const subject = getHeader(headers, "Subject") || "";
    const fromAddress = getHeader(headers, "From") || "";
    const dateHeader = getHeader(headers, "Date");
    const bodyText = extractMessageText(full.payload);
    const parsed = parseDisputeEmail({ subject, bodyText });

    let matchedShipmentId = null;

    if (parsed.trackingNumber) {
      // Only escalate a shipment INTO 'disputed' - never downgrade one
      // that's already further along (credit_note / resolved), and never
      // silently re-flip something a person already manually changed away
      // from 'disputed' back to it just because we re-see an old email.
      // dispute_status_changed_at is stamped with the EMAIL's own date
      // (falling back to NOW() if the Date header is missing) rather than
      // "now" - the dispute was actually filed with FedEx on that date, not
      // whenever we happened to run this sync, and the aging/stale check
      // (`only=stale`) depends on this being accurate.
      const { rows: updatedRows } = await queryDb(
        `UPDATE shipments SET dispute_status = 'disputed', dispute_ref = $1,
                dispute_status_changed_at = COALESCE($3::timestamptz, NOW())
         WHERE tracking_number = $2 AND dispute_status IN ('none', 'flagged')
         RETURNING id`,
        [parsed.refNo, parsed.trackingNumber, dateHeader ? new Date(dateHeader).toISOString() : null]
      );

      if (updatedRows.length) {
        statusUpdated += updatedRows.length;
        matchedShipmentId = updatedRows[0].id;
      } else {
        // Either no shipment with this tracking number exists yet, or one
        // does but is already past 'disputed' - still link the email to it
        // for the "İtiraz E-postaları" panel if we can find one.
        const { rows: anyMatch } = await queryDb(
          `SELECT id FROM shipments WHERE tracking_number = $1 ORDER BY id LIMIT 1`,
          [parsed.trackingNumber]
        );
        matchedShipmentId = anyMatch[0]?.id ?? null;
        if (!matchedShipmentId) unmatchedTracking++;
      }
    }

    await queryDb(
      `INSERT INTO dispute_emails (
         gmail_message_id, gmail_thread_id, subject, from_address, received_at,
         ref_no, invoice_no, tracking_number, account_number, dispute_date,
         contact_name, contact_email, weight_value, weight_unit, dispute_reason,
         snippet, body_text, matched_shipment_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       ON CONFLICT (gmail_message_id) DO NOTHING`,
      [
        m.id,
        m.threadId,
        subject,
        fromAddress,
        dateHeader ? new Date(dateHeader).toISOString() : null,
        parsed.refNo,
        parsed.invoiceNo,
        parsed.trackingNumber,
        parsed.accountNumber,
        parseFedexDateToIso(parsed.disputeDate),
        parsed.contactName,
        parsed.contactEmail,
        parsed.weightValue,
        parsed.weightUnit,
        parsed.disputeReason,
        full.snippet || null,
        bodyText.slice(0, 8000),
        matchedShipmentId,
      ]
    );
    imported++;
  }

  await markGmailSynced();

  return Response.json({
    scanned,
    alreadyKnown,
    imported,
    statusUpdated,
    unmatchedTracking,
    resultSizeEstimate: list.resultSizeEstimate ?? null,
  });
});
