import { ensureSchema, apiHandler } from "../../../../lib/db.js";
import { clearGmailConnection } from "../../../../lib/settings.js";

export const POST = apiHandler(async () => {
  await ensureSchema();
  await clearGmailConnection();
  return Response.json({ ok: true });
});
