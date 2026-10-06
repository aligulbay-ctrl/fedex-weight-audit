import { queryDb, ensureSchema } from "./db.js";

const DEFAULT_API_BASE = "https://apis.fedex.com";

/**
 * Effective settings, DB row (set from the Settings page) taking priority
 * over env vars (Vercel-configured), which remain a fallback default.
 * `fedexClientSecretSet` tells the UI whether a secret exists without ever
 * exposing its value again once saved.
 */
export async function getSettings() {
  await ensureSchema();
  const { rows } = await queryDb(`SELECT * FROM app_settings WHERE id = 1`);
  const row = rows[0] || {};

  const fedexClientId = row.fedex_client_id || process.env.FEDEX_CLIENT_ID || "";
  const fedexClientSecret = row.fedex_client_secret || process.env.FEDEX_CLIENT_SECRET || "";

  return {
    fedexClientId,
    fedexClientSecret,
    fedexClientIdSource: row.fedex_client_id ? "settings" : process.env.FEDEX_CLIENT_ID ? "env" : null,
    fedexClientSecretSet: Boolean(fedexClientSecret),
    fedexClientSecretSource: row.fedex_client_secret ? "settings" : process.env.FEDEX_CLIENT_SECRET ? "env" : null,
    fedexApiBase: row.fedex_api_base || process.env.FEDEX_API_BASE || DEFAULT_API_BASE,
    discrepancyThresholdKg:
      row.discrepancy_threshold_kg != null
        ? parseFloat(row.discrepancy_threshold_kg)
        : parseFloat(process.env.DISCREPANCY_THRESHOLD_KG || "0.5"),
    discrepancyThresholdPct:
      row.discrepancy_threshold_pct != null
        ? parseFloat(row.discrepancy_threshold_pct)
        : parseFloat(process.env.DISCREPANCY_THRESHOLD_PCT || "5"),
    // Days an "İtiraz Edildi" shipment can sit without progressing before
    // it's flagged as stale (see `only=stale` in app/api/shipments/route.js).
    disputeStaleDays:
      row.dispute_stale_days != null
        ? parseInt(row.dispute_stale_days, 10)
        : parseInt(process.env.DISPUTE_STALE_DAYS || "15", 10),
    // FedEx is understood to only accept/act on billing disputes at or
    // above this |fark| (kg) - below it a shipment can still be a real
    // discrepancy, just not one worth filing with FedEx (see
    // only=fedex_eligible / below_threshold in app/api/shipments/route.js).
    fedexMinDisputeKg:
      row.fedex_min_dispute_kg != null
        ? parseFloat(row.fedex_min_dispute_kg)
        : parseFloat(process.env.FEDEX_MIN_DISPUTE_KG || "2"),

    // Gmail OAuth (for pulling FedEx "Your dispute record" emails) - no env
    // var fallback, since these are per-account OAuth credentials, not
    // something you'd want as a shared Vercel env var.
    gmailClientId: row.gmail_client_id || "",
    gmailClientSecret: row.gmail_client_secret || "",
    gmailClientSecretSet: Boolean(row.gmail_client_secret),
    gmailRefreshToken: row.gmail_refresh_token || "",
    gmailConnected: Boolean(row.gmail_refresh_token),
    gmailEmail: row.gmail_email || "",
    gmailConnectedAt: row.gmail_connected_at || null,
    gmailLastSyncedAt: row.gmail_last_synced_at || null,
  };
}

// Returns the settings shape safe to send to the browser (no secret/token value).
export async function getPublicSettings() {
  const s = await getSettings();
  return {
    fedexClientId: s.fedexClientId,
    fedexClientIdSource: s.fedexClientIdSource,
    fedexClientSecretSet: s.fedexClientSecretSet,
    fedexClientSecretSource: s.fedexClientSecretSource,
    fedexApiBase: s.fedexApiBase,
    discrepancyThresholdKg: s.discrepancyThresholdKg,
    discrepancyThresholdPct: s.discrepancyThresholdPct,
    disputeStaleDays: s.disputeStaleDays,
    fedexMinDisputeKg: s.fedexMinDisputeKg,
    gmailClientId: s.gmailClientId,
    gmailClientSecretSet: s.gmailClientSecretSet,
    gmailConnected: s.gmailConnected,
    gmailEmail: s.gmailEmail,
    gmailConnectedAt: s.gmailConnectedAt,
    gmailLastSyncedAt: s.gmailLastSyncedAt,
  };
}

export async function updateSettings(partial) {
  await ensureSchema();

  const fields = [];
  const values = [];
  const set = (col, val) => {
    fields.push(`${col} = $${fields.length + 1}`);
    values.push(val);
  };

  if (partial.fedexClientId !== undefined) set("fedex_client_id", partial.fedexClientId || null);
  // Empty string means "leave the existing secret alone" (the UI never
  // shows the real value back, so an empty field isn't "clear it").
  if (partial.fedexClientSecret) set("fedex_client_secret", partial.fedexClientSecret);
  if (partial.fedexApiBase !== undefined) set("fedex_api_base", partial.fedexApiBase || null);
  if (partial.discrepancyThresholdKg !== undefined)
    set("discrepancy_threshold_kg", partial.discrepancyThresholdKg === "" ? null : partial.discrepancyThresholdKg);
  if (partial.discrepancyThresholdPct !== undefined)
    set("discrepancy_threshold_pct", partial.discrepancyThresholdPct === "" ? null : partial.discrepancyThresholdPct);
  if (partial.disputeStaleDays !== undefined)
    set("dispute_stale_days", partial.disputeStaleDays === "" ? null : partial.disputeStaleDays);
  if (partial.fedexMinDisputeKg !== undefined)
    set("fedex_min_dispute_kg", partial.fedexMinDisputeKg === "" ? null : partial.fedexMinDisputeKg);

  if (partial.gmailClientId !== undefined) set("gmail_client_id", partial.gmailClientId || null);
  if (partial.gmailClientSecret) set("gmail_client_secret", partial.gmailClientSecret);

  if (fields.length === 0) return getPublicSettings();

  fields.push(`updated_at = NOW()`);

  // Make sure the single settings row exists, then update just the
  // provided fields on it.
  await queryDb(`INSERT INTO app_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
  await queryDb(`UPDATE app_settings SET ${fields.join(", ")} WHERE id = 1`, values);

  return getPublicSettings();
}

// Called from the OAuth callback once Google hands back a refresh token -
// separate from updateSettings() because it's triggered by the redirect
// flow, not a form submit, and always overwrites (a fresh "Gmail ile
// bağlan" always means "use this token from now on").
export async function saveGmailConnection({ refreshToken, email }) {
  await ensureSchema();
  await queryDb(`INSERT INTO app_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
  await queryDb(
    `UPDATE app_settings SET gmail_refresh_token=$1, gmail_email=$2, gmail_connected_at=NOW() WHERE id=1`,
    [refreshToken, email]
  );
}

export async function clearGmailConnection() {
  await ensureSchema();
  await queryDb(
    `UPDATE app_settings SET gmail_refresh_token=NULL, gmail_email=NULL, gmail_connected_at=NULL WHERE id=1`
  );
}

export async function markGmailSynced() {
  await ensureSchema();
  await queryDb(`UPDATE app_settings SET gmail_last_synced_at=NOW() WHERE id=1`);
}
