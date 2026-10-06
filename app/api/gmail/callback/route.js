import { ensureSchema, apiHandler } from "../../../../lib/db.js";
import { getSettings, saveGmailConnection } from "../../../../lib/settings.js";
import { exchangeCodeForTokens, getGmailProfile } from "../../../../lib/gmailClient.js";

export const runtime = "nodejs";

// GET /api/gmail/callback - Google redirects here after the user approves
// (or denies) access on the consent screen.
export const GET = apiHandler(async (req) => {
  await ensureSchema();
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) {
    return Response.redirect(`${url.origin}/settings?gmail_error=${encodeURIComponent(error)}`, 302);
  }
  if (!code) {
    return Response.redirect(`${url.origin}/settings?gmail_error=missing_code`, 302);
  }

  const settings = await getSettings();
  if (!settings.gmailClientId || !settings.gmailClientSecret) {
    return Response.redirect(`${url.origin}/settings?gmail_error=not_configured`, 302);
  }

  try {
    const redirectUri = `${url.origin}/api/gmail/callback`;
    const tokens = await exchangeCodeForTokens({
      code,
      clientId: settings.gmailClientId,
      clientSecret: settings.gmailClientSecret,
      redirectUri,
    });

    if (!tokens.refresh_token) {
      // Happens if the user had already granted consent before and Google
      // didn't re-issue a refresh_token (shouldn't occur since we pass
      // prompt=consent, but guard anyway with a clear message).
      return Response.redirect(`${url.origin}/settings?gmail_error=no_refresh_token`, 302);
    }

    const profile = await getGmailProfile(tokens.access_token);
    await saveGmailConnection({ refreshToken: tokens.refresh_token, email: profile.emailAddress });

    return Response.redirect(`${url.origin}/settings?gmail=connected`, 302);
  } catch (err) {
    console.error("[gmail callback error]", err);
    return Response.redirect(`${url.origin}/settings?gmail_error=${encodeURIComponent(err.message)}`, 302);
  }
});
