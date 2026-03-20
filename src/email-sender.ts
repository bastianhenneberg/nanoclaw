/**
 * Standalone email sender for IPC and other internal use.
 * Supports multi-account: picks the right SMTP config by account address.
 * Falls back to the first account with SMTP configured.
 */
import { createTransport } from 'nodemailer';

import { parseEmailAccounts, EmailAccountConfig } from './email-accounts.js';
import { MicrosoftTokenManager } from './oauth2.js';
import { logger } from './logger.js';

export interface SendEmailOptions {
  to: string | string[];
  subject: string;
  body: string;
  from?: string;
  html?: string;
  replyTo?: string;
  /** Account address to send from. If omitted, uses first account with SMTP. */
  account?: string;
}

function findAccount(accountAddress?: string): EmailAccountConfig | null {
  const accounts = parseEmailAccounts();
  if (accounts.length === 0) return null;

  if (accountAddress) {
    const match = accounts.find(
      (a) =>
        a.address.toLowerCase() === accountAddress.toLowerCase() && a.smtpHost,
    );
    if (match) return match;
  }

  // Fall back to first account with SMTP configured
  return accounts.find((a) => a.smtpHost) || null;
}

export async function buildSmtpTransport(cfg: EmailAccountConfig) {
  const config = await buildTransportConfig(cfg);
  return createTransport(config);
}

async function buildTransportConfig(cfg: EmailAccountConfig): Promise<object> {
  if (cfg.authType === 'oauth2') {
    const tokenMgr = new MicrosoftTokenManager({
      clientId: cfg.oauth2ClientId,
      clientSecret: cfg.oauth2ClientSecret,
      tenantId: cfg.oauth2TenantId,
      grantType: cfg.oauth2GrantType,
      refreshToken: cfg.oauth2RefreshToken || undefined,
    });
    const accessToken = await tokenMgr.getAccessToken();
    return {
      host: cfg.smtpHost,
      port: cfg.smtpPort,
      secure: cfg.smtpUseSSL,
      auth: { type: 'OAuth2', user: cfg.address, accessToken },
    };
  }

  if (cfg.smtpUseSSL) {
    return {
      host: cfg.smtpHost,
      port: cfg.smtpPort,
      secure: true,
      auth: { user: cfg.address, pass: cfg.password },
    };
  }

  return {
    host: cfg.smtpHost,
    port: cfg.smtpPort,
    secure: false,
    auth: { user: cfg.address, pass: cfg.password },
    tls: { rejectUnauthorized: cfg.smtpUseTLS },
  };
}

export async function sendEmail(options: SendEmailOptions): Promise<boolean> {
  const cfg = findAccount(options.account);
  if (!cfg) {
    logger.warn('Email sender: no account with SMTP configured');
    return false;
  }

  const from = options.from || cfg.fromAddress || cfg.address;
  const to = Array.isArray(options.to) ? options.to.join(', ') : options.to;

  try {
    const transportConfig = await buildTransportConfig(cfg);
    const transport = createTransport(transportConfig);
    await transport.sendMail({
      from,
      to,
      subject: options.subject,
      text: options.body,
      html: options.html,
      replyTo: options.replyTo,
    });

    logger.info(
      { to, subject: options.subject, account: cfg.address },
      'Email sent via IPC',
    );
    return true;
  } catch (err) {
    logger.error(
      { err, to, subject: options.subject, account: cfg.address },
      'Failed to send email',
    );
    return false;
  }
}
