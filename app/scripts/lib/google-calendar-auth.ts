/**
 * Shared Google OAuth for calendar scripts.
 *
 * SETUP (one-time):
 * 1. https://console.cloud.google.com/ → create/select a project
 * 2. Enable "Google Calendar API" under APIs & Services → Library
 * 3. APIs & Services → Credentials → Create OAuth 2.0 Client ID (type: Desktop app)
 *    → download JSON → save as app/credentials/google-oauth.json
 * 4. APIs & Services → OAuth consent screen → Test users → add your Google account
 * 5. First script run opens a browser for consent; token is cached at
 *    app/credentials/google-token.json and auto-refreshes after that.
 */

import { google } from 'googleapis';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { URL } from 'url';

const CREDENTIALS_DIR = path.resolve(import.meta.dirname, '..', '..', 'credentials');
const OAUTH_PATH = path.join(CREDENTIALS_DIR, 'google-oauth.json');
const TOKEN_PATH = path.join(CREDENTIALS_DIR, 'google-token.json');

const SCOPES = ['https://www.googleapis.com/auth/calendar.readonly'];
const REDIRECT_PORT = 3333;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}`;

function loadCredentials() {
  if (!fs.existsSync(OAUTH_PATH)) {
    console.error(`\n❌ Missing OAuth credentials file at:\n   ${OAUTH_PATH}\n`);
    console.error('See the header of this file for setup steps.\n');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(OAUTH_PATH, 'utf-8'));
}

function createOAuth2Client(credentials: any) {
  const creds = credentials.installed || credentials.web;
  if (!creds) throw new Error('Invalid credentials format');
  return new google.auth.OAuth2(creds.client_id, creds.client_secret, REDIRECT_URI);
}

async function getNewTokenViaLocalServer(oAuth2Client: any): Promise<void> {
  const authUrl = oAuth2Client.generateAuthUrl({ access_type: 'offline', scope: SCOPES, prompt: 'consent' });

  console.log('\n🔐 Authorization required. Opening browser...\n');
  console.log(`   ${authUrl}\n`);

  const { exec } = await import('child_process');
  exec(`open "${authUrl}"`);

  console.log(`   ⏳ Waiting for you to authorize (listening on ${REDIRECT_URI})...\n`);

  const code = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (!req.url) return;
      const url = new URL(req.url, REDIRECT_URI);
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      if (error) {
        res.end('Authorization denied.');
        server.close();
        reject(new Error(`Auth denied: ${error}`));
        return;
      }
      if (code) {
        res.end('✅ Authorization successful! You can close this tab.');
        server.close();
        resolve(code);
        return;
      }
      res.writeHead(200);
      res.end('');
    });

    server.listen(REDIRECT_PORT, () => {});

    setTimeout(() => {
      server.close();
      reject(new Error('Timeout waiting for OAuth callback (120s). Make sure to complete the consent in the browser.'));
    }, 120_000);
  });

  const { tokens } = await oAuth2Client.getToken(code);
  oAuth2Client.setCredentials(tokens);

  if (!fs.existsSync(CREDENTIALS_DIR)) fs.mkdirSync(CREDENTIALS_DIR, { recursive: true });
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
  console.log('   ✅ Token saved to', TOKEN_PATH);
}

export async function authorizeGoogleCalendar() {
  const credentials = loadCredentials();
  const oAuth2Client = createOAuth2Client(credentials);

  if (fs.existsSync(TOKEN_PATH)) {
    oAuth2Client.setCredentials(JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8')));
    return oAuth2Client;
  }

  await getNewTokenViaLocalServer(oAuth2Client);
  return oAuth2Client;
}

export async function fetchAllCalendarEvents(auth: any, calendarId: string, timeMin: Date, timeMax: Date) {
  const calendar = google.calendar({ version: 'v3', auth });
  const events: any[] = [];
  let pageToken: string | undefined = undefined;

  do {
    const res = await calendar.events.list({
      calendarId,
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 2500,
      pageToken,
    });
    events.push(...(res.data.items || []));
    pageToken = res.data.nextPageToken || undefined;
  } while (pageToken);

  return events;
}

export async function getCalendarColorMap(auth: any): Promise<Record<string, { background: string; foreground: string }>> {
  const calendar = google.calendar({ version: 'v3', auth });
  const res = await calendar.colors.get();
  return (res.data.event || {}) as Record<string, { background: string; foreground: string }>;
}
