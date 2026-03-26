import { writeIpcResponse } from '../ipc-shared.js';
import { sendEmail } from '../integrations/email-sender.js';
import { logger } from '../logger.js';

export async function handleSendEmail(
  data: {
    to?: string | string[];
    subject?: string;
    body?: string;
    from?: string;
    html?: string;
    replyTo?: string;
    account?: string;
  },
  sourceGroup: string,
): Promise<void> {
  if (data.to && data.subject && data.body) {
    const to = Array.isArray(data.to) ? data.to : [data.to];
    const success = await sendEmail({
      to,
      subject: data.subject as string,
      body: data.body as string,
      from: data.from as string | undefined,
      html: data.html as string | undefined,
      replyTo: data.replyTo as string | undefined,
      account: data.account as string | undefined,
    });
    if (success) {
      logger.info(
        { sourceGroup, to, subject: data.subject },
        'Email sent via IPC',
      );
    }
  } else {
    logger.warn(
      { data },
      'Invalid send_email request - missing to, subject, or body',
    );
  }
}

export async function handleListEmails(
  data: {
    account?: string;
    folder?: string;
    limit?: number;
    unreadOnly?: boolean;
    requestId?: string;
  },
  sourceGroup: string,
): Promise<void> {
  if (!data.account || !data.requestId) return;
  try {
    const { listEmails } = await import('../channels/email.js');
    const result = await listEmails({
      account: data.account as string,
      folder: (data.folder as string) || 'INBOX',
      limit: (data.limit as number) || 10,
      unreadOnly: (data.unreadOnly as boolean) || false,
    });
    writeIpcResponse(sourceGroup, data.requestId, { result });
    logger.info(
      {
        sourceGroup,
        account: data.account,
        count: result.split('\n').length,
      },
      'Email list fetched via IPC',
    );
  } catch (err) {
    writeIpcResponse(sourceGroup, data.requestId, {
      error: String(err),
    });
    logger.error(
      { sourceGroup, account: data.account, err },
      'Error listing emails',
    );
  }
}

export async function handleReadEmail(
  data: {
    account?: string;
    uid?: number;
    folder?: string;
    requestId?: string;
  },
  sourceGroup: string,
): Promise<void> {
  if (!data.account || !data.uid || !data.requestId) return;
  try {
    const { readEmail } = await import('../channels/email.js');
    const result = await readEmail({
      account: data.account as string,
      uid: data.uid as number,
      folder: (data.folder as string) || undefined,
    });
    writeIpcResponse(sourceGroup, data.requestId, { result });
    logger.info(
      { sourceGroup, account: data.account, uid: data.uid },
      'Email read via IPC',
    );
  } catch (err) {
    writeIpcResponse(sourceGroup, data.requestId, {
      error: String(err),
    });
    logger.error(
      { sourceGroup, account: data.account, uid: data.uid, err },
      'Error reading email',
    );
  }
}

export async function handleForwardEmail(
  data: {
    account?: string;
    uid?: number;
    to?: string | string[];
    folder?: string;
    comment?: string;
    requestId?: string;
  },
  sourceGroup: string,
): Promise<void> {
  if (!data.account || !data.uid || !data.to || !data.requestId) return;
  try {
    const { forwardEmail } = await import('../channels/email.js');
    const success = await forwardEmail({
      account: data.account as string,
      uid: data.uid as number,
      to: data.to as string | string[],
      folder: (data.folder as string) || undefined,
      comment: (data.comment as string) || undefined,
    });
    writeIpcResponse(sourceGroup, data.requestId, {
      result: success ? 'Email forwarded successfully' : 'Forward failed',
    });
    logger.info(
      {
        sourceGroup,
        account: data.account,
        uid: data.uid,
        to: data.to,
        success,
      },
      'Email forward via IPC',
    );
  } catch (err) {
    writeIpcResponse(sourceGroup, data.requestId, {
      error: String(err),
    });
    logger.error(
      { sourceGroup, account: data.account, uid: data.uid, err },
      'Error forwarding email',
    );
  }
}

export async function handleEmailAction(
  data: {
    action?: string;
    messageId?: string;
    account?: string;
    archiveFolder?: string;
  },
  sourceGroup: string,
): Promise<void> {
  if (!data.action || !data.messageId || !data.account) {
    logger.warn(
      { data },
      'Invalid email_action request - missing action, messageId, or account',
    );
    return;
  }
  try {
    const { performEmailAction } = await import('../channels/email.js');
    const success = await performEmailAction({
      action: data.action as
        | 'delete'
        | 'archive'
        | 'mark_read'
        | 'mark_unread',
      messageId: data.messageId as string,
      account: data.account as string,
      archiveFolder: (data.archiveFolder as string) || 'Archive',
    });
    if (success) {
      logger.info(
        {
          sourceGroup,
          action: data.action,
          messageId: data.messageId,
          account: data.account,
        },
        'Email action performed via IPC',
      );
    } else {
      logger.warn(
        {
          sourceGroup,
          action: data.action,
          messageId: data.messageId,
          account: data.account,
        },
        'Email action failed',
      );
    }
  } catch (err) {
    logger.error(
      {
        sourceGroup,
        action: data.action,
        messageId: data.messageId,
        err,
      },
      'Error performing email action',
    );
  }
}

export async function handleListMailboxes(
  data: {
    account?: string;
    requestId?: string;
  },
  sourceGroup: string,
): Promise<void> {
  if (!data.account || !data.requestId) return;
  try {
    const { listMailboxes } = await import('../channels/email.js');
    const mailboxes = await listMailboxes({
      account: data.account as string,
    });
    const lines = ['📁 Available folders:', ''];
    for (const mb of mailboxes) {
      const specialUse = mb.specialUse ? ` (${mb.specialUse})` : '';
      lines.push(`• ${mb.path}${specialUse}`);
    }
    writeIpcResponse(sourceGroup, data.requestId, {
      result: lines.join('\n'),
    });
    logger.info(
      { sourceGroup, account: data.account, count: mailboxes.length },
      'Mailboxes listed via IPC',
    );
  } catch (err) {
    writeIpcResponse(sourceGroup, data.requestId, {
      error: String(err),
    });
    logger.error(
      { sourceGroup, account: data.account, err },
      'Error listing mailboxes',
    );
  }
}

export async function handleSearchEmails(
  data: {
    account?: string;
    query?: string;
    folders?: string[];
    limit?: number;
    includeDeleted?: boolean;
    requestId?: string;
  },
  sourceGroup: string,
): Promise<void> {
  if (!data.account || !data.requestId) return;
  try {
    const { searchEmails } = await import('../channels/email.js');
    const results = await searchEmails({
      account: data.account as string,
      query: (data.query as string) || '',
      folders: data.folders as string[] | undefined,
      limit: (data.limit as number) || 20,
      includeDeleted: (data.includeDeleted as boolean) || false,
    });

    if (results.length === 0) {
      writeIpcResponse(sourceGroup, data.requestId, {
        result: 'No emails found matching your search.',
      });
    } else {
      const lines = [
        `🔍 Found ${results.length} email(s) for "${data.query}":`,
        '',
      ];
      for (const email of results) {
        const marker = email.isUnread ? '🔵' : '⚪';
        lines.push(`${marker} **${email.subject}**`);
        lines.push(`   From: ${email.from}`);
        lines.push(
          `   Date: ${email.date ? new Date(email.date).toLocaleString('de-DE') : 'n/a'}`,
        );
        lines.push(`   Folder: ${email.folder}`);
        lines.push(`   IMAP-UID: ${email.uid}`);
        if (email.preview) {
          lines.push(`   Preview: ${email.preview.slice(0, 150)}...`);
        }
        lines.push('');
      }
      writeIpcResponse(sourceGroup, data.requestId, {
        result: lines.join('\n'),
      });
    }
    logger.info(
      {
        sourceGroup,
        account: data.account,
        query: data.query,
        count: results.length,
      },
      'Email search completed via IPC',
    );
  } catch (err) {
    writeIpcResponse(sourceGroup, data.requestId, {
      error: String(err),
    });
    logger.error(
      { sourceGroup, account: data.account, query: data.query, err },
      'Error searching emails',
    );
  }
}

export async function handleMoveEmail(
  data: {
    account?: string;
    uid?: number;
    fromFolder?: string;
    toFolder?: string;
    requestId?: string;
  },
  sourceGroup: string,
): Promise<void> {
  if (!data.account || !data.uid || !data.fromFolder || !data.toFolder || !data.requestId) return;
  try {
    const { moveEmail } = await import('../channels/email.js');
    await moveEmail({
      account: data.account as string,
      uid: data.uid as number,
      fromFolder: data.fromFolder as string,
      toFolder: data.toFolder as string,
    });
    writeIpcResponse(sourceGroup, data.requestId, {
      result: `Email moved from ${data.fromFolder} to ${data.toFolder}`,
    });
    logger.info(
      {
        sourceGroup,
        account: data.account,
        uid: data.uid,
        fromFolder: data.fromFolder,
        toFolder: data.toFolder,
      },
      'Email moved via IPC',
    );
  } catch (err) {
    writeIpcResponse(sourceGroup, data.requestId, {
      error: String(err),
    });
    logger.error(
      {
        sourceGroup,
        account: data.account,
        uid: data.uid,
        err,
      },
      'Error moving email',
    );
  }
}

export async function handleReplyEmail(
  data: {
    account?: string;
    uid?: number;
    body?: string;
    folder?: string;
    html?: string;
    requestId?: string;
  },
  sourceGroup: string,
): Promise<void> {
  if (!data.account || !data.uid || !data.body || !data.requestId) return;
  try {
    const { replyEmail } = await import('../channels/email.js');
    await replyEmail({
      account: data.account as string,
      uid: data.uid as number,
      body: data.body as string,
      folder: (data.folder as string) || undefined,
      html: (data.html as string) || undefined,
    });
    writeIpcResponse(sourceGroup, data.requestId, {
      result: 'Reply sent successfully',
    });
    logger.info(
      { sourceGroup, account: data.account, uid: data.uid },
      'Email reply sent via IPC',
    );
  } catch (err) {
    writeIpcResponse(sourceGroup, data.requestId, {
      error: String(err),
    });
    logger.error(
      { sourceGroup, account: data.account, uid: data.uid, err },
      'Error sending email reply',
    );
  }
}

export async function handleFlagEmail(
  data: {
    account?: string;
    uid?: number;
    folder?: string;
    flag?: string;
    requestId?: string;
  },
  sourceGroup: string,
): Promise<void> {
  if (!data.account || !data.uid || !data.flag || !data.requestId) return;
  try {
    const { flagEmail } = await import('../channels/email.js');
    await flagEmail({
      account: data.account as string,
      uid: data.uid as number,
      folder: (data.folder as string) || undefined,
      flag: data.flag as 'flagged' | 'unflagged',
    });
    const action = data.flag === 'flagged' ? 'flagged' : 'unflagged';
    writeIpcResponse(sourceGroup, data.requestId, {
      result: `Email ${action}`,
    });
    logger.info(
      { sourceGroup, account: data.account, uid: data.uid, flag: data.flag },
      'Email flag updated via IPC',
    );
  } catch (err) {
    writeIpcResponse(sourceGroup, data.requestId, {
      error: String(err),
    });
    logger.error(
      { sourceGroup, account: data.account, uid: data.uid, err },
      'Error flagging email',
    );
  }
}

export async function handleCopyEmail(
  data: {
    account?: string;
    uid?: number;
    fromFolder?: string;
    toFolder?: string;
    requestId?: string;
  },
  sourceGroup: string,
): Promise<void> {
  if (!data.account || !data.uid || !data.fromFolder || !data.toFolder || !data.requestId) return;
  try {
    const { copyEmail } = await import('../channels/email.js');
    await copyEmail({
      account: data.account as string,
      uid: data.uid as number,
      fromFolder: data.fromFolder as string,
      toFolder: data.toFolder as string,
    });
    writeIpcResponse(sourceGroup, data.requestId, {
      result: `Email copied from ${data.fromFolder} to ${data.toFolder}`,
    });
    logger.info(
      {
        sourceGroup,
        account: data.account,
        uid: data.uid,
        fromFolder: data.fromFolder,
        toFolder: data.toFolder,
      },
      'Email copied via IPC',
    );
  } catch (err) {
    writeIpcResponse(sourceGroup, data.requestId, {
      error: String(err),
    });
    logger.error(
      { sourceGroup, account: data.account, uid: data.uid, err },
      'Error copying email',
    );
  }
}

export async function handleCreateFolder(
  data: {
    account?: string;
    folderPath?: string;
    requestId?: string;
  },
  sourceGroup: string,
): Promise<void> {
  if (!data.account || !data.folderPath || !data.requestId) return;
  try {
    const { createFolder } = await import('../channels/email.js');
    await createFolder({
      account: data.account as string,
      folderPath: data.folderPath as string,
    });
    writeIpcResponse(sourceGroup, data.requestId, {
      result: `Folder "${data.folderPath}" created`,
    });
    logger.info(
      { sourceGroup, account: data.account, folderPath: data.folderPath },
      'Folder created via IPC',
    );
  } catch (err) {
    writeIpcResponse(sourceGroup, data.requestId, {
      error: String(err),
    });
    logger.error(
      { sourceGroup, account: data.account, folderPath: data.folderPath, err },
      'Error creating folder',
    );
  }
}
