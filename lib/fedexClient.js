// Thin client for FedEx's Track API (OAuth2 client-credentials + POST
// /track/v1/trackingnumbers). Docs: https://developer.fedex.com/api/en-us/catalog/track.html
//
// IMPORTANT - read before relying on this in production:
// FedEx's public tracking page (fedex.com/fedextrack) shows a "Package
// details" block with WEIGHT (per-piece) and, for multi-piece shipments,
// a separate TOTAL SHIPMENT WEIGHT + TOTAL PIECES. That page is a UI over
// the same Track API this module calls, so the data exists - but FedEx's
// exact JSON field names/nesting for the *aggregate* multi-piece weight
// have shifted across API versions and aren't fully confirmed here without
// a live sandbox response in hand. `extractActualWeightKg()` below tries
// several known/likely paths in order of preference and ALSO does a
// last-resort recursive scan for any {value, unit: KG|LB} pair, so it
// degrades gracefully instead of silently returning nothing. Every raw
// response is stored (fedex_raw_response) specifically so a human can spot
// a wrong pick and this function can be tightened later without re-fetching.

import { toKg } from "./weightUtils.js";
import { getSettings } from "./settings.js";

// Cache the token per client_id, so switching credentials on the Settings
// page (without a redeploy) doesn't keep using a token issued for the old
// ones.
let tokenCache = { clientId: null, accessToken: null, expiresAt: 0 };

// True if either the Settings page or env vars have both a client id and secret.
export async function fedexConfigured() {
  const s = await getSettings();
  return Boolean(s.fedexClientId && s.fedexClientSecret);
}

async function getAccessToken() {
  const s = await getSettings();
  if (!s.fedexClientId || !s.fedexClientSecret) {
    throw new Error("FedEx Client ID / Client Secret tanımlı değil (Ayarlar sayfasından girin).");
  }
  if (
    tokenCache.accessToken &&
    tokenCache.clientId === s.fedexClientId &&
    tokenCache.expiresAt > Date.now() + 30_000
  ) {
    return tokenCache.accessToken;
  }
  const res = await fetch(`${s.fedexApiBase}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: s.fedexClientId,
      client_secret: s.fedexClientSecret,
    }),
  });
  if (!res.ok) {
    const body = await safeText(res);
    throw new Error(`FedEx OAuth failed (${res.status}): ${body}`);
  }
  const data = await res.json();
  tokenCache = {
    clientId: s.fedexClientId,
    accessToken: data.access_token,
    expiresAt: Date.now() + (data.expires_in ? data.expires_in * 1000 : 55 * 60 * 1000),
  };
  return tokenCache.accessToken;
}

/**
 * Standalone OAuth check for the Settings page's "Bağlantıyı test et"
 * button - doesn't touch the shared token cache, just confirms the given
 * credentials actually get a token back from FedEx.
 */
export async function testCredentials({ clientId, clientSecret, apiBase }) {
  if (!clientId || !clientSecret) {
    return { ok: false, error: "Client ID ve Client Secret gerekli." };
  }
  try {
    const res = await fetch(`${apiBase || "https://apis.fedex.com"}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });
    if (!res.ok) {
      const body = await safeText(res);
      let msg = body;
      try {
        const parsed = JSON.parse(body);
        msg = parsed.errors?.map((e) => e.message).join("; ") || parsed.error_description || body;
      } catch {
        // body wasn't JSON, use as-is
      }
      return { ok: false, error: `FedEx OAuth reddetti (HTTP ${res.status}): ${msg}` };
    }
    const data = await res.json();
    return { ok: true, expiresIn: data.expires_in };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Looks up one tracking number and returns:
 *   { ok, actualWeightKg, weightSource, status, raw, error }
 * Never throws for a "shipment not found" / API-level error - that's
 * reported back via `ok:false` + `error` so a batch sync can keep going.
 */
export async function trackShipment(trackingNumber) {
  try {
    const [token, s] = await Promise.all([getAccessToken(), getSettings()]);
    const res = await fetch(`${s.fedexApiBase}/track/v1/trackingnumbers`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-locale": "en_US",
      },
      body: JSON.stringify({
        includeDetailedScans: false,
        trackingInfo: [{ trackingNumberInfo: { trackingNumber } }],
      }),
    });

    const raw = await res.json().catch(() => null);

    if (!res.ok) {
      const msg =
        raw?.errors?.map((e) => e.message).join("; ") || `FedEx Track API HTTP ${res.status}`;
      return { ok: false, actualWeightKg: null, weightSource: null, status: null, raw, error: msg };
    }

    const trackResults = raw?.output?.completeTrackResults?.flatMap((r) => r.trackResults || []) || [];

    if (trackResults.length === 0) {
      return { ok: false, actualWeightKg: null, weightSource: null, status: null, raw, error: "No trackResults returned" };
    }

    const apiError = trackResults[0]?.error?.message;
    const status = trackResults[0]?.latestStatusDetail?.description || null;

    const { weightKg, source } = extractActualWeightKg(trackResults);
    const totalPieces = extractTotalPieces(trackResults);

    if (weightKg == null) {
      return {
        ok: false,
        actualWeightKg: null,
        weightSource: null,
        totalPieces,
        status,
        raw,
        error: apiError || "Weight field not found in FedEx response (see raw response)",
      };
    }

    return { ok: true, actualWeightKg: weightKg, weightSource: source, totalPieces, status, raw, error: null };
  } catch (err) {
    return { ok: false, actualWeightKg: null, weightSource: null, totalPieces: null, status: null, raw: null, error: err.message };
  }
}

// Mirrors the "Total Pieces" figure fedex.com/fedextrack shows for
// multi-piece shipments. Same defensive, multi-path approach as the weight
// extraction above, since the exact field isn't 100% confirmed from public
// docs - falls back to the number of trackResults (one per piece) as a
// last resort, which is correct for the MPS shape we've seen in practice.
function extractTotalPieces(trackResults) {
  for (const tr of trackResults) {
    const n = parseInt(tr?.packageDetails?.count, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  for (const tr of trackResults) {
    const n = parseInt(tr?.shipmentDetails?.numberOfPieces ?? tr?.shipmentDetails?.pieceCount, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  if (trackResults.length > 1) return trackResults.length;
  return null;
}

function extractActualWeightKg(trackResults) {
  // 1) Multi-piece shipment (MPS): FedEx often returns one trackResult per
  // piece under the same master tracking number. Check this BEFORE the
  // single-result path below, or per-piece weight would get mistaken for
  // the total. Sum every piece's packageDetails weight for the true
  // "total shipment weight" (this is the figure FedEx bills against, and
  // what fedex.com's own tracking page labels "Total shipment weight").
  if (trackResults.length > 1) {
    let sum = 0;
    let found = false;
    for (const tr of trackResults) {
      const w = firstWeightAsKg(tr?.packageDetails?.weightAndDimensions?.weight);
      if (w != null) {
        sum += w;
        found = true;
      }
    }
    if (found) return { weightKg: round(sum), source: `sum of ${trackResults.length} packageDetails entries (MPS)` };
  }

  // 2) Single trackResult: an explicit shipment-level or package-level weight.
  for (const tr of trackResults) {
    const agg = tr?.shipmentDetails?.weight || tr?.packageDetails?.weightAndDimensions?.weight;
    const kg = firstWeightAsKg(agg);
    if (kg != null) return { weightKg: kg, source: "packageDetails.weightAndDimensions (single trackResult)" };
  }

  // 3) Last resort: recursively scan the whole payload for any {value, unit}
  // pair with a KG/LB unit and take the largest one found (a "total" figure
  // is usually >= any single-package figure).
  const found = [];
  scanForWeights(trackResults, found);
  if (found.length) {
    const best = found.sort((a, b) => b.kg - a.kg)[0];
    return { weightKg: round(best.kg), source: "recursive scan fallback - verify against raw_response" };
  }

  return { weightKg: null, source: null };
}

function firstWeightAsKg(weightField) {
  if (!weightField) return null;
  const entries = Array.isArray(weightField) ? weightField : [weightField];
  for (const w of entries) {
    const kg = toKg(parseFloat(w?.value), w?.units || w?.unit);
    if (kg != null && Number.isFinite(kg)) return kg;
  }
  return null;
}

function scanForWeights(node, out, depth = 0) {
  if (!node || depth > 8) return;
  if (Array.isArray(node)) {
    for (const item of node) scanForWeights(item, out, depth + 1);
    return;
  }
  if (typeof node === "object") {
    const unit = node.units || node.unit;
    const value = node.value;
    if (unit && value != null && /^(KG|KGS|LB|LBS)$/i.test(String(unit))) {
      const kg = toKg(parseFloat(value), unit);
      if (kg != null && Number.isFinite(kg)) out.push({ kg });
    }
    for (const key of Object.keys(node)) scanForWeights(node[key], out, depth + 1);
  }
}

function round(n) {
  return Math.round(n * 1000) / 1000;
}

async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return "";
  }
}
