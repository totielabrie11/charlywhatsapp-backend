/**
 * Shared Google Calendar OAuth2 helpers.
 * Extracted from calendar.ts so calendarSync.ts can import them without
 * creating a circular dependency.
 */
import { google } from "googleapis";
import { db } from "@workspace/db";
import { googleCalendarTokensTable, googleCalendarSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

function getCalendarRedirectUri(): string {
  const uri = process.env.GOOGLE_REDIRECT_URI;
  if (!uri) {
    throw new Error(
      "GOOGLE_REDIRECT_URI environment variable is required but was not provided. " +
        "Set it to this backend's own OAuth callback URL, e.g. " +
        "https://charlywhatsapp-backend.onrender.com/api/calendar/auth/callback " +
        "— it must exactly match a redirect URI registered in the Google Cloud Console.",
    );
  }
  return uri;
}

export async function getOAuthCredentials(workspaceId: number) {
  const [row] = await db
    .select()
    .from(googleCalendarSettingsTable)
    .where(eq(googleCalendarSettingsTable.workspaceId, workspaceId));

  if (row) {
    return { clientId: row.clientId, clientSecret: row.clientSecret };
  }
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (clientId && clientSecret) {
    return { clientId, clientSecret };
  }
  return null;
}

export async function makeOAuth2Client(workspaceId: number) {
  const creds = await getOAuthCredentials(workspaceId);
  if (!creds) {
    const err = new Error("credentials_not_configured");
    (err as any).statusCode = 400;
    throw err;
  }
  return new google.auth.OAuth2(creds.clientId, creds.clientSecret, getCalendarRedirectUri());
}

/** Returns a fully-credentialled OAuth2 client, auto-refreshing if needed. */
export async function getAuthedClient(workspaceId: number) {
  const [token] = await db
    .select()
    .from(googleCalendarTokensTable)
    .where(eq(googleCalendarTokensTable.workspaceId, workspaceId));

  if (!token) {
    const err = new Error("not_connected");
    (err as any).statusCode = 401;
    throw err;
  }

  const oauth2Client = await makeOAuth2Client(workspaceId);
  oauth2Client.setCredentials({
    access_token: token.accessToken,
    refresh_token: token.refreshToken,
    expiry_date: token.expiresAt.getTime(),
  });

  // Proactively refresh if the token expires in < 5 minutes.
  if (token.expiresAt.getTime() < Date.now() + 5 * 60 * 1000) {
    const { credentials } = await oauth2Client.refreshAccessToken();
    await db
      .update(googleCalendarTokensTable)
      .set({
        accessToken: credentials.access_token!,
        expiresAt: new Date(credentials.expiry_date!),
        updatedAt: new Date(),
      })
      .where(eq(googleCalendarTokensTable.workspaceId, workspaceId));
    oauth2Client.setCredentials(credentials);
  }

  return oauth2Client;
}
