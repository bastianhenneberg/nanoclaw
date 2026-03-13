/**
 * Microsoft OAuth2 token manager for Office 365 / Exchange Online.
 *
 * Supports two grant types:
 *
 *   client_credentials — App-only access (service account).
 *     Requires "full_access_as_app" permission in Azure AD.
 *     No refresh token needed; the app authenticates itself.
 *
 *   refresh_token — Delegated access (on behalf of a user).
 *     Requires a refresh token obtained once via auth-code flow.
 *     The token is silently refreshed before expiry.
 *
 * Usage:
 *   const mgr = new MicrosoftTokenManager({ ... });
 *   const token = await mgr.getAccessToken();
 */

import { logger } from './logger.js';

export interface MicrosoftOAuth2Config {
  clientId: string;
  clientSecret: string;
  tenantId: string;
  /** 'client_credentials' for service accounts, 'refresh_token' for user accounts */
  grantType: 'client_credentials' | 'refresh_token';
  /** Required when grantType = 'refresh_token' */
  refreshToken?: string;
  /** OAuth2 scope – defaults to Office 365 IMAP/SMTP full access */
  scope?: string;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  token_type: string;
}

const DEFAULT_SCOPE = 'https://outlook.office365.com/.default';

/** How many seconds before expiry to proactively refresh. */
const REFRESH_BUFFER_SECS = 300; // 5 minutes

export class MicrosoftTokenManager {
  private accessToken: string | null = null;
  private expiresAt: number = 0; // unix timestamp in seconds
  private currentRefreshToken: string | undefined;
  private refreshPromise: Promise<string> | null = null;

  constructor(private readonly config: MicrosoftOAuth2Config) {
    this.currentRefreshToken = config.refreshToken;
  }

  /**
   * Returns a valid access token, refreshing if needed.
   * Concurrent calls share the same refresh promise to avoid duplicate requests.
   */
  async getAccessToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);

    if (this.accessToken && this.expiresAt - REFRESH_BUFFER_SECS > now) {
      return this.accessToken;
    }

    // Deduplicate concurrent refresh calls
    if (this.refreshPromise) return this.refreshPromise;

    this.refreshPromise = this.doRefresh().finally(() => {
      this.refreshPromise = null;
    });

    return this.refreshPromise;
  }

  /** Force-invalidate the cached token (e.g. on 401 responses). */
  invalidate(): void {
    this.accessToken = null;
    this.expiresAt = 0;
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private async doRefresh(): Promise<string> {
    logger.debug(
      { grantType: this.config.grantType },
      'OAuth2: refreshing access token',
    );

    const token = await this.fetchToken();
    this.accessToken = token.access_token;
    this.expiresAt = Math.floor(Date.now() / 1000) + token.expires_in;

    // Update stored refresh token if server rotated it
    if (token.refresh_token) {
      this.currentRefreshToken = token.refresh_token;
    }

    logger.info(
      { expiresIn: token.expires_in, grantType: this.config.grantType },
      'OAuth2: access token obtained',
    );

    return this.accessToken;
  }

  private async fetchToken(): Promise<TokenResponse> {
    const { clientId, clientSecret, tenantId, grantType, scope } = this.config;
    const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
    const resolvedScope = scope ?? DEFAULT_SCOPE;

    const params = new URLSearchParams();
    params.set('client_id', clientId);
    params.set('client_secret', clientSecret);
    params.set('scope', resolvedScope);

    if (grantType === 'client_credentials') {
      params.set('grant_type', 'client_credentials');
    } else {
      if (!this.currentRefreshToken) {
        throw new Error(
          'OAuth2 refresh_token grant requires a refresh token. ' +
            'Set EMAIL_OAUTH2_REFRESH_TOKEN in your .env file.',
        );
      }
      params.set('grant_type', 'refresh_token');
      params.set('refresh_token', this.currentRefreshToken);
      params.set('offline_access', '');
    }

    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    if (!res.ok) {
      const body = await res.text();
      logger.error(
        { status: res.status, body },
        'OAuth2: token request failed',
      );
      throw new Error(`OAuth2 token request failed (${res.status}): ${body}`);
    }

    return (await res.json()) as TokenResponse;
  }
}
