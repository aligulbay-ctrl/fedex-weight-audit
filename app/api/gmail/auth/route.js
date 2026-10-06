import { ensureSchema, apiHandler } from "../../../../lib/db.js";
import { getSettings } from "../../../../lib/settings.js";
import { buildAuthUrl } from "../../../../lib/gmailClient.js";

// GET /api/gmail/auth - kicks off the OAuth flow. Linked from the "Gmail
// ile bağlan" button on the Settings page. Redirect_uri is derived from
// the incoming request's own origin, so this works unchanged on
// localhost, a Vercel preview URL, and production - Google just needs
// that exact URL added under "Authorized redirect URIs" for the OAuth
// client (see README).
export const GET = apiHandler(async (req) => {
  await ensureSchema();
  const settings = await getSettings();

  if (!settings.gmailClientId || !settings.gmailClientSecret) {
    return new Response(
      "Önce Ayarlar sayfasında Gmail Client ID / Client Secret girip kaydedin, sonra 'Gmail ile bağlan'a tıklayın.",
      { status: 400 }
    );
  }

  const url = new URL(req.url);
  const redirectUri = `${url.origin}/api/gmail/callback`;

  const authUrl = buildAuthUrl({ clientId: settings.gmailClientId, redirectUri });
  return Response.redirect(authUrl, 302);
});
