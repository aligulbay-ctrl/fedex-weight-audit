import { apiHandler } from "../../../lib/db.js";
import { getPublicSettings, updateSettings } from "../../../lib/settings.js";

export const GET = apiHandler(async () => {
  return Response.json(await getPublicSettings());
});

export const PATCH = apiHandler(async (req) => {
  const body = await req.json().catch(() => ({}));

  const partial = {};
  if (body.fedexClientId !== undefined) partial.fedexClientId = String(body.fedexClientId).trim();
  if (body.fedexClientSecret) partial.fedexClientSecret = String(body.fedexClientSecret).trim();
  if (body.fedexApiBase !== undefined) partial.fedexApiBase = String(body.fedexApiBase).trim();
  if (body.discrepancyThresholdKg !== undefined) {
    partial.discrepancyThresholdKg = body.discrepancyThresholdKg === "" ? "" : parseFloat(body.discrepancyThresholdKg);
  }
  if (body.discrepancyThresholdPct !== undefined) {
    partial.discrepancyThresholdPct = body.discrepancyThresholdPct === "" ? "" : parseFloat(body.discrepancyThresholdPct);
  }
  if (body.disputeStaleDays !== undefined) {
    partial.disputeStaleDays = body.disputeStaleDays === "" ? "" : parseInt(body.disputeStaleDays, 10);
  }
  if (body.fedexMinDisputeKg !== undefined) {
    partial.fedexMinDisputeKg = body.fedexMinDisputeKg === "" ? "" : parseFloat(body.fedexMinDisputeKg);
  }
  if (body.gmailClientId !== undefined) partial.gmailClientId = String(body.gmailClientId).trim();
  if (body.gmailClientSecret) partial.gmailClientSecret = String(body.gmailClientSecret).trim();

  const updated = await updateSettings(partial);
  return Response.json(updated);
});
