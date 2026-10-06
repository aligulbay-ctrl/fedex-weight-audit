import { apiHandler } from "../../../../lib/db.js";
import { getSettings } from "../../../../lib/settings.js";
import { testCredentials } from "../../../../lib/fedexClient.js";

// Lets the Settings page verify FedEx credentials immediately (OAuth
// token request) instead of waiting until the next sync to find out they
// were wrong. If the form's secret field was left blank (because we never
// echo the real secret back), falls back to whatever is already saved.
export const POST = apiHandler(async (req) => {
  const body = await req.json().catch(() => ({}));
  const saved = await getSettings();

  const clientId = body.fedexClientId?.trim() || saved.fedexClientId;
  const clientSecret = body.fedexClientSecret?.trim() || saved.fedexClientSecret;
  const apiBase = body.fedexApiBase?.trim() || saved.fedexApiBase;

  const result = await testCredentials({ clientId, clientSecret, apiBase });
  return Response.json(result);
});
