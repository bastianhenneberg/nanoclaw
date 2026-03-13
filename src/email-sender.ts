/**
 * Standalone email sender for IPC and other internal use.
 * Uses the same SMTP config as the email channel.
 */
import { createTransport, Transporter } from 'nodemailer';

import {
  EMAIL_ADDRESS,
  EMAIL_FROM_ADDRESS,
  EMAIL_PASSWORD,
  EMAIL_SMTP_HOST,
  EMAIL_SMTP_PORT,
  EMAIL_SMTP_USE_SSL,
  EMAIL_SMTP_USE_TLS,
} from './config.js';
import { logger } from './logger.js';

let transporter: Transporter | null = null;

function getTransporter(): Transporter | null {
  if (!EMAIL_SMTP_HOST || !EMAIL_ADDRESS || !EMAIL_PASSWORD) {
    logger.warn('Email sender: SMTP not configured');
    return null;
  }

  if (!transporter) {
    transporter = createTransport({
      host: EMAIL_SMTP_HOST,
      port: EMAIL_SMTP_PORT,
      secure: EMAIL_SMTP_USE_SSL,
      auth: {
        user: EMAIL_ADDRESS,
        pass: EMAIL_PASSWORD,
      },
      ...(EMAIL_SMTP_USE_TLS && !EMAIL_SMTP_USE_SSL
        ? { requireTLS: true }
        : {}),
    });
  }

  return transporter;
}

export interface SendEmailOptions {
  to: string | string[];
  subject: string;
  body: string;
  from?: string;
  html?: string;
  replyTo?: string;
}

export async function sendEmail(options: SendEmailOptions): Promise<boolean> {
  const transport = getTransporter();
  if (!transport) {
    return false;
  }

  const from = options.from || EMAIL_FROM_ADDRESS || EMAIL_ADDRESS;
  const to = Array.isArray(options.to) ? options.to.join(', ') : options.to;

  try {
    await transport.sendMail({
      from,
      to,
      subject: options.subject,
      text: options.body,
      html: options.html,
      replyTo: options.replyTo,
    });

    logger.info({ to, subject: options.subject }, 'Email sent via IPC');
    return true;
  } catch (err) {
    logger.error({ err, to, subject: options.subject }, 'Failed to send email');
    return false;
  }
}
