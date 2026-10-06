// Thin client for pulling FedEx "Your dispute record" confirmation emails
// out of Gmail via OAuth2 (authorization-code + refresh-token flow) and the
// Gmail REST API. No third-party Google SDK - plain fetch, same pattern as
// lib/fedexClient.js.
//
// IMPORTANT - Google's OAuth consent screen: for a personal (non-Workspace)
// Gmail account, this app can only run as an "External" OAuth client in
// "Testing" publishing status (avoids Google's app-verification review,
// which is a heavy process for the restricted gmail.readonly scope and not
// worth it for a single internal user). The tradeoff: Google expires
// refresh tokens issued to Testing-status apps after ~7 days, so every so
// often "Gmail ile bağlan" will need to be clicked again. getAccessToken()
// below surfaces that as a clear `gmailAuthError` flag rather than a raw
// invalid_grant error, so the Settings page can prompt to reconnect.

import { getSettings } from "./settings.js";

export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

// Overridable only via env vars (never a user-facing Setting) so a local
// mock Google/Gmail server can be used for testing without touching
// production behavior - unset in normal/deployed use, so these are always
// the real Google endpoints for actual users.
const GOOGLE_AUTH_URL = process.env.GOOGLE_OAUTH_AUTH_URL_OVERRIDE || "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = process.env.GOOGLE_OAUTH_TOKEN_URL_OVERRIDE || "https://oauth2.googleapis.com/token";
const GMAIL_API_BASE = process.env.GMAIL_API_BASE_OVERRIDE || "https://gmail.googleapis.com/gmail/v1";

// Matches FedEx's "Your dispute record Ref # ..." confirmation emails.
// Kept broad (subject phrase + sender domain) rather than an exact sender
// address, since FedEx has sent these from both noreply@fedex.com and
// donotreply@fedex.com in the wild.
const DISPUTE_QUERY = 'subject:"dispute record" from:fedex.com';

let tokenCache = { refreshToken: null, accessToken: null, expiresAt: 0 };

export function buildAuthUrl({ clientId, redirectUri, state }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GMAIL_SCOPE,
    access_type: "offline",
    // Forces Google to hand back a refresh_token even if this user
    // authorized before - without this a repeat "Gmail ile bağlan" click
    // can silently return no refresh_token.
    prompt: "consent",
    include_granted_scopes: "true",
    ...(state ? { state } : {}),
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

export async function exchangeCodeForTokens({ code, clientId, clientSecret, redirectUri }) {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
    }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(data?.error_description || data?.error || `Google token endpoint HTTP ${res.status}`);
  }
  return data; // { access_token, refresh_token, expires_in, scope, token_type }
}

// True if the Settings page has a Gmail client id/secret AND a stored
// refresh token (i.e. "Gmail ile bağlan" was completed).
export async function gmailConfigured() {
  const s = await getSettings();
  return Boolean(s.gmailClientId && s.gmailClientSecret && s.gmailRefreshToken);
}

export async function getAccessToken() {
  const s = await getSettings();
  if (!s.gmailClientId || !s.gmailClientSecret || !s.gmailRefreshToken) {
    throw new Error("Gmail bağlantısı yapılandırılmamış (Ayarlar sayfasından 'Gmail ile bağlan').");
  }
  if (
    tokenCache.accessToken &&
    tokenCache.refreshToken === s.gmailRefreshToken &&
    tokenCache.expiresAt > Date.now() + 30_000
  ) {
    return tokenCache.accessToken;
  }

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: s.gmailRefreshToken,
      client_id: s.gmailClientId,
      client_secret: s.gmailClientSecret,
    }),
  });
  if (!res.ok) {
    const raw = await safeText(res);
    let msg = raw;
    let isAuthError = false;
    try {
      const parsed = JSON.parse(raw);
      msg = parsed.error_description || parsed.error || raw;
      isAuthError = parsed.error === "invalid_grant";
    } catch {
      // not JSON, use raw text
    }
    const err = new Error(
      isAuthError
        ? `Gmail bağlantısının süresi dolmuş - Ayarlar sayfasından 'Gmail ile bağlan'a tekrar tıklayın. (${msg})`
        : `Gmail token yenilenemedi: ${msg}`
    );
    err.gmailAuthError = isAuthError;
    throw err;
  }
  const data = await res.json();
  tokenCache = {
    refreshToken: s.gmailRefreshToken,
    accessToken: data.access_token,
    expiresAt: Date.now() + (data.expires_in ? data.expires_in * 1000 : 55 * 60 * 1000),
  };
  return tokenCache.accessToken;
}

export async function getGmailProfile(accessToken) {
  const res = await fetch(`${GMAIL_API_BASE}/users/me/profile`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Gmail profili alınamadı (HTTP ${res.status}): ${await safeText(res)}`);
  return res.json(); // { emailAddress, messagesTotal, threadsTotal, historyId }
}

export async function listDisputeMessageIds(accessToken, { pageToken, maxResults = 25 } = {}) {
  const params = new URLSearchParams({ q: DISPUTE_QUERY, maxResults: String(maxResults) });
  if (pageToken) params.set("pageToken", pageToken);
  const res = await fetch(`${GMAIL_API_BASE}/users/me/messages?${params.toString()}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Gmail arama başarısız (HTTP ${res.status}): ${await safeText(res)}`);
  return res.json(); // { messages: [{id, threadId}], nextPageToken, resultSizeEstimate }
}

export async function getMessage(accessToken, id) {
  const res = await fetch(`${GMAIL_API_BASE}/users/me/messages/${id}?format=full`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Gmail mesajı alınamadı (HTTP ${res.status}): ${await safeText(res)}`);
  return res.json();
}

export function getHeader(headers, name) {
  const h = (headers || []).find((x) => x.name?.toLowerCase() === name.toLowerCase());
  return h?.value || null;
}

function base64UrlDecode(data) {
  const base64 = data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(base64, "base64").toString("utf-8");
}

function findBodyParts(payload, found) {
  if (!payload) return;
  if (payload.mimeType === "text/plain" && payload.body?.data && !found.plain) {
    found.plain = base64UrlDecode(payload.body.data);
  } else if (payload.mimeType === "text/html" && payload.body?.data && !found.html) {
    found.html = base64UrlDecode(payload.body.data);
  }
  if (Array.isArray(payload.parts)) {
    for (const part of payload.parts) findBodyParts(part, found);
  }
}

function htmlToText(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|table|li)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"');
}

function normalizeText(s) {
  return s.replace(/\s+/g, " ").trim();
}

// Extracts a plain-text version of a Gmail message body (prefers the
// text/plain MIME part; falls back to stripping tags from text/html).
export function extractMessageText(payload) {
  const found = {};
  findBodyParts(payload, found);
  if (found.plain) return normalizeText(found.plain);
  if (found.html) return normalizeText(htmlToText(found.html));
  return "";
}

// FedEx's confirmation email lays these out as a fixed-order label/value
// table ("Dispute date", "Account number", ... "Dispute reason"). Rather
// than trying to parse HTML table structure (fragile against template
// tweaks), we normalize the whole body to one space-separated string and
// walk the KNOWN labels in their known order, taking each field's value as
// the text between that label and whichever known label comes next. This
// stays correct even though one field's VALUE can itself be the word
// "Weight" (the "Dispute reason" value), because we always search forward
// from a monotonically advancing cursor.
const FIELD_LABELS = [
  { key: "disputeDate", label: "Dispute date" },
  { key: "accountNumber", label: "Account number" },
  { key: "contactName", label: "Contact name" },
  { key: "contactEmail", label: "Contact email" },
  { key: "contactPhone", label: "Contact phone" },
  { key: "invoiceNo", label: "Invoice number" },
  { key: "trackingNumber", label: "Tracking ID" },
  { key: "packageId", label: "Package ID" },
  { key: "weightValue", label: "Weight" },
  { key: "weightUnit", label: "Weight UOM" },
  { key: "disputeReason", label: "Dispute reason" },
  // Sentinel-only entries (key: null) - "Dispute reason" is the last real
  // table field, immediately followed by free-text closing boilerplate
  // ("Login to your FedEx Billing Online account...", "Thank you for your
  // business, FedEx"). Without a bounding marker after it, its value would
  // swallow that entire closing paragraph. These are never stored, only
  // used to know where the previous field's value ends.
  { key: null, label: "Login to your" },
  { key: null, label: "Thank you for your business" },
];

function extractLabeledFields(text) {
  const result = {};
  let cursor = 0;
  for (let i = 0; i < FIELD_LABELS.length; i++) {
    const { key, label } = FIELD_LABELS[i];
    if (!key) continue; // sentinel-only, never itself extracted
    const idx = text.indexOf(label, cursor);
    if (idx === -1) continue;
    const valueStart = idx + label.length;
    let valueEnd = text.length;
    for (let j = i + 1; j < FIELD_LABELS.length; j++) {
      const nextIdx = text.indexOf(FIELD_LABELS[j].label, valueStart);
      if (nextIdx !== -1) {
        valueEnd = nextIdx;
        break;
      }
    }
    // Clamp defensively - if no bounding label/sentinel was found (template
    // changed), this stops a field from swallowing the rest of the email
    // instead of just failing to populate one field.
    result[key] = text.slice(valueStart, valueEnd).replace(/^[:\s]+/, "").trim().slice(0, 200);
    cursor = valueStart;
  }
  return result;
}

const MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };

// "24-Aug-2026" -> "2026-08-24" (Postgres DATE-friendly). Returns null
// (rather than throwing) for anything that doesn't match, so a template
// change degrades to "field just not filled in" instead of a crash - the
// raw body_text is always stored too, for manual reconciliation.
export function parseFedexDateToIso(s) {
  if (!s) return null;
  const m = s.match(/(\d{1,2})-([A-Za-z]{3})-(\d{4})/);
  if (!m) return null;
  const mon = MONTHS[m[2]];
  if (!mon) return null;
  return `${m[3]}-${String(mon).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
}

export function parseDisputeEmail({ subject, bodyText }) {
  const refMatch = (subject || "").match(/Ref\s*#\s*(.+)$/i);
  const refNo = refMatch ? refMatch[1].trim() : null;

  const fields = extractLabeledFields(bodyText || "");

  return {
    refNo,
    disputeDate: fields.disputeDate || null,
    accountNumber: fields.accountNumber || null,
    contactName: fields.contactName || null,
    contactEmail: fields.contactEmail || null,
    contactPhone: fields.contactPhone || null,
    invoiceNo: fields.invoiceNo || null,
    trackingNumber: fields.trackingNumber || null,
    packageId: fields.packageId || null,
    weightValue: fields.weightValue ? parseFloat(fields.weightValue.replace(",", ".")) : null,
    weightUnit: fields.weightUnit || null,
    disputeReason: fields.disputeReason || null,
  };
}

async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return "";
  }
}
