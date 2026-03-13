/**
 * Paperless-ngx → Lexoffice Bridge
 *
 * Receives webhook calls from Paperless-ngx when a document is tagged,
 * downloads the PDF, and uploads it to the correct Lexoffice account
 * based on the document's tags.
 *
 * Tag mapping:
 *   "Lexoffice CT" → Crewtex Lexoffice account
 *   "Lexoffice PD" → Peppermint Digital Lexoffice account
 *
 * Environment variables (.env):
 *   PAPERLESS_API_URL          Paperless instance URL
 *   PAPERLESS_API_TOKEN        Paperless API token
 *   LEXOFFICE_CT_API_KEY       Lexoffice API key for Crewtex
 *   LEXOFFICE_PD_API_KEY       Lexoffice API key for Peppermint Digital
 */

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Config (secrets read from .env, not exported)
// ---------------------------------------------------------------------------

const secrets = readEnvFile([
  'PAPERLESS_API_URL',
  'PAPERLESS_API_TOKEN',
  'LEXOFFICE_CT_API_KEY',
  'LEXOFFICE_PD_API_KEY',
]);

const PAPERLESS_URL = (
  process.env.PAPERLESS_API_URL ||
  secrets.PAPERLESS_API_URL ||
  ''
).replace(/\/+$/, '');
const PAPERLESS_TOKEN =
  process.env.PAPERLESS_API_TOKEN || secrets.PAPERLESS_API_TOKEN || '';

const LEXOFFICE_BASE = 'https://api.lexware.io/v1';

interface LexofficeAccount {
  name: string;
  tag: string;
  apiKey: string;
}

const ACCOUNTS: LexofficeAccount[] = [
  {
    name: 'Crewtex',
    tag: 'Lexoffice CT',
    apiKey: process.env.LEXOFFICE_CT_API_KEY || secrets.LEXOFFICE_CT_API_KEY || '',
  },
  {
    name: 'Peppermint Digital',
    tag: 'Lexoffice PD',
    apiKey: process.env.LEXOFFICE_PD_API_KEY || secrets.LEXOFFICE_PD_API_KEY || '',
  },
];

// ---------------------------------------------------------------------------
// Paperless API helpers
// ---------------------------------------------------------------------------

interface PaperlessDocument {
  id: number;
  title: string;
  tags: number[];
  original_file_name: string;
}

interface PaperlessTag {
  id: number;
  name: string;
}

async function paperlessFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${PAPERLESS_URL}${path}`, {
    headers: { Authorization: `Token ${PAPERLESS_TOKEN}` },
  });
  if (!res.ok) {
    throw new Error(`Paperless ${path}: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

async function getDocument(docId: number): Promise<PaperlessDocument> {
  return paperlessFetch<PaperlessDocument>(`/api/documents/${docId}/`);
}

async function getTagNames(tagIds: number[]): Promise<string[]> {
  if (tagIds.length === 0) return [];
  const tags = await Promise.all(
    tagIds.map((id) => paperlessFetch<PaperlessTag>(`/api/tags/${id}/`)),
  );
  return tags.map((t) => t.name);
}

async function downloadDocument(docId: number): Promise<Buffer> {
  const res = await fetch(`${PAPERLESS_URL}/api/documents/${docId}/download/`, {
    headers: { Authorization: `Token ${PAPERLESS_TOKEN}` },
  });
  if (!res.ok) {
    throw new Error(
      `Paperless download ${docId}: ${res.status} ${res.statusText}`,
    );
  }
  return Buffer.from(await res.arrayBuffer());
}

// ---------------------------------------------------------------------------
// Lexoffice upload
// ---------------------------------------------------------------------------

async function uploadToLexoffice(
  account: LexofficeAccount,
  fileBuffer: Buffer,
  fileName: string,
): Promise<{ id: string }> {
  // Build multipart form data manually (Node 18+ fetch supports FormData)
  const formData = new FormData();
  const blob = new Blob([fileBuffer], { type: 'application/pdf' });
  formData.append('file', blob, fileName);
  formData.append('type', 'voucher');

  const res = await fetch(`${LEXOFFICE_BASE}/files`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${account.apiKey}`,
      Accept: 'application/json',
    },
    body: formData,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Lexoffice upload (${account.name}): ${res.status} ${body}`,
    );
  }

  return res.json() as Promise<{ id: string }>;
}

// ---------------------------------------------------------------------------
// Main handler (called from webhook-server.ts)
// ---------------------------------------------------------------------------

export interface PaperlessWebhookResult {
  ok: boolean;
  documentId?: number;
  title?: string;
  account?: string;
  lexofficeFileId?: string;
  error?: string;
  skipped?: boolean;
}

/**
 * Process a Paperless-ngx webhook payload.
 *
 * Paperless sends: { "document_id": 123 } (added_tag trigger)
 */
export async function handlePaperlessWebhook(
  payload: Record<string, unknown>,
): Promise<PaperlessWebhookResult> {
  logger.info({ payload }, 'Paperless webhook: raw payload received');

  // Paperless-ngx may send document_id directly, or doc_url containing the ID
  let docId = (payload.document_id ?? payload.id ?? payload.doc_id) as number | undefined;

  // Extract ID from doc_url if present (e.g. "http://paperless/documents/42/details")
  if (!docId && typeof payload.doc_url === 'string') {
    const match = payload.doc_url.match(/\/documents\/(\d+)/);
    if (match) docId = parseInt(match[1], 10);
  }

  if (!docId) {
    return { ok: false, error: `Missing document_id in payload. Keys: ${Object.keys(payload).join(', ')}` };
  }

  if (!PAPERLESS_URL || !PAPERLESS_TOKEN) {
    return { ok: false, error: 'PAPERLESS_API_URL or PAPERLESS_API_TOKEN not configured' };
  }

  logger.info({ docId }, 'Paperless webhook: processing document');

  // 1. Get document metadata
  const doc = await getDocument(docId);
  const tagNames = await getTagNames(doc.tags);

  logger.info({ docId, title: doc.title, tags: tagNames }, 'Document metadata');

  // 2. Find matching Lexoffice account
  const account = ACCOUNTS.find((a) => tagNames.includes(a.tag));
  if (!account) {
    logger.info(
      { docId, tags: tagNames },
      'No Lexoffice tag found, skipping',
    );
    return {
      ok: true,
      documentId: docId,
      title: doc.title,
      skipped: true,
      error: `No matching Lexoffice tag found (tags: ${tagNames.join(', ')})`,
    };
  }

  if (!account.apiKey) {
    return {
      ok: false,
      documentId: docId,
      error: `API key not configured for ${account.name}`,
    };
  }

  // 3. Download PDF from Paperless
  logger.info({ docId, account: account.name }, 'Downloading document');
  const pdfBuffer = await downloadDocument(docId);

  // 4. Upload to Lexoffice
  const fileName = doc.original_file_name || `${doc.title}.pdf`;
  logger.info(
    { docId, account: account.name, fileName, size: pdfBuffer.length },
    'Uploading to Lexoffice',
  );
  const result = await uploadToLexoffice(account, pdfBuffer, fileName);

  logger.info(
    { docId, account: account.name, lexofficeFileId: result.id },
    'Successfully uploaded to Lexoffice',
  );

  return {
    ok: true,
    documentId: docId,
    title: doc.title,
    account: account.name,
    lexofficeFileId: result.id,
  };
}

/**
 * Check if the Paperless-Lexoffice bridge is configured.
 */
export function isPaperlessLexofficeEnabled(): boolean {
  return !!(
    PAPERLESS_URL &&
    PAPERLESS_TOKEN &&
    ACCOUNTS.some((a) => a.apiKey)
  );
}
