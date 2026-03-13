/**
 * One-time OAuth2 authorization code flow to obtain a refresh token
 * for Office 365 IMAP/SMTP access.
 *
 * Usage:
 *   npx tsx scripts/oauth2-token.ts <email-address>
 *
 * Opens a browser for login, then prints the refresh token.
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { URL } from 'url';

// Read credentials from .env file
function readEnvVar(key: string): string {
  try {
    const envPath = path.join(process.cwd(), '.env');
    const content = fs.readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const k = trimmed.slice(0, eqIdx).trim();
      if (k !== key) continue;
      let val = trimmed.slice(eqIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      return val;
    }
  } catch {}
  return process.env[key] || '';
}

const TENANT_ID = readEnvVar('EMAIL_3_OAUTH2_TENANT_ID');
const CLIENT_ID = readEnvVar('EMAIL_3_OAUTH2_CLIENT_ID');
const CLIENT_SECRET = readEnvVar('EMAIL_3_OAUTH2_CLIENT_SECRET');

if (!TENANT_ID || !CLIENT_ID || !CLIENT_SECRET) {
  console.error('Missing OAuth2 config in .env (EMAIL_3_OAUTH2_TENANT_ID, CLIENT_ID, CLIENT_SECRET)');
  process.exit(1);
}

const REDIRECT_URI = 'http://localhost:3000/callback';
const SCOPES = [
  'offline_access',
  'https://outlook.office365.com/IMAP.AccessAsUser.All',
  'https://outlook.office365.com/SMTP.Send',
].join(' ');

const email = process.argv[2];
if (!email) {
  console.error('Usage: npx tsx scripts/oauth2-token.ts <email-address>');
  process.exit(1);
}

const authUrl = new URL(`https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/authorize`);
authUrl.searchParams.set('client_id', CLIENT_ID);
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
authUrl.searchParams.set('scope', SCOPES);
authUrl.searchParams.set('login_hint', email);
authUrl.searchParams.set('prompt', 'consent');

console.log(`\nÖffne diesen Link im Browser:\n`);
console.log(authUrl.toString());
console.log(`\nWarte auf Callback...\n`);

const server = http.createServer(async (req, res) => {
  if (!req.url?.startsWith('/callback')) {
    res.writeHead(404);
    res.end();
    return;
  }

  const url = new URL(req.url, 'http://localhost:3000');
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) {
    const desc = url.searchParams.get('error_description') || error;
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<h1>Fehler</h1><p>${desc}</p>`);
    console.error(`\nFehler: ${desc}`);
    process.exit(1);
  }

  if (!code) {
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>Kein Code erhalten</h1>');
    return;
  }

  // Exchange code for tokens
  const params = new URLSearchParams();
  params.set('client_id', CLIENT_ID);
  params.set('client_secret', CLIENT_SECRET);
  params.set('grant_type', 'authorization_code');
  params.set('code', code);
  params.set('redirect_uri', REDIRECT_URI);
  params.set('scope', SCOPES);

  const tokenRes = await fetch(`https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  const tokenData = await tokenRes.json();

  if (!tokenRes.ok) {
    res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<h1>Token-Fehler</h1><pre>${JSON.stringify(tokenData, null, 2)}</pre>`);
    console.error('\nToken-Fehler:', JSON.stringify(tokenData, null, 2));
    process.exit(1);
  }

  const refreshToken = tokenData.refresh_token;

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<h1>Fertig!</h1><p>Refresh Token für <b>${email}</b> erhalten. Du kannst dieses Fenster schließen.</p>`);

  console.log(`\n✅ Refresh Token für ${email}:\n`);
  console.log(refreshToken);
  console.log(`\nFüge das in die .env ein als EMAIL_X_OAUTH2_REFRESH_TOKEN=...\n`);

  server.close(() => process.exit(0));
});

server.listen(3000, () => {
  console.log('Lokaler Server läuft auf http://localhost:3000');
});
