/**
 * Stdio MCP Server for NanoClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';
const hostGroupsDir = process.env.NANOCLAW_HOST_GROUPS_DIR || '';

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

const server = new McpServer({
  name: 'nanoclaw',
  version: '1.0.0',
});

server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times.",
  {
    text: z.string().describe('The message text to send'),
    sender: z.string().optional().describe('Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram groups. Only works in group chats — pool bots cannot send to private chats.'),
    chat_jid: z.string().optional().describe('(Main group only) Target chat JID to send to. Defaults to the current chat. Use this to send team messages to a group chat (e.g. "tg:-5071189865") instead of the private chat.'),
  },
  async (args) => {
    // Main can override target; non-main always sends to own chat
    const targetJid = isMain && args.chat_jid ? args.chat_jid : chatJid;

    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid: targetJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);

server.tool(
  'send_photo',
  'Send a photo/image file to the user or group. The file must exist on the container filesystem (e.g. in /workspace/group/, /workspace/extra/, or a generated file).',
  {
    file_path: z.string().describe('Absolute path to the image file on the container filesystem'),
    caption: z.string().optional().describe('Optional caption for the photo'),
    sender: z.string().optional().describe('Your role/identity name (e.g. "Researcher"). When set, photo is sent from a dedicated bot in Telegram groups.'),
    chat_jid: z.string().optional().describe('(Main group only) Target chat JID. Defaults to current chat.'),
  },
  async (args) => {
    if (!fs.existsSync(args.file_path)) {
      return {
        content: [{ type: 'text' as const, text: `File not found: ${args.file_path}` }],
        isError: true,
      };
    }

    const targetJid = isMain && args.chat_jid ? args.chat_jid : chatJid;

    const data: Record<string, string | undefined> = {
      type: 'photo',
      chatJid: targetJid,
      filePath: args.file_path,
      caption: args.caption || undefined,
      sender: args.sender || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Photo sent.' }] };
  },
);

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools. Returns the task ID for future reference. To modify an existing task, use update_task instead.

CONTEXT MODE - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
\u2022 "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" \u2192 group (needs conversation context)
- "Check the weather every morning" \u2192 isolated (self-contained task)
- "Follow up on my request" \u2192 group (needs to know what was requested)
- "Generate a daily report" \u2192 isolated (just needs instructions in prompt)

MESSAGING BEHAVIOR - The task agent's output is sent to the user or group. It can also use send_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
  {
    prompt: z.string().describe('What the agent should do when the task runs. For isolated mode, include all necessary context here.'),
    schedule_type: z.enum(['cron', 'interval', 'once']).describe('cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time'),
    schedule_value: z.string().describe('cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)'),
    context_mode: z.enum(['group', 'isolated']).default('group').describe('group=runs with chat history and memory, isolated=fresh session (include context in prompt)'),
    target_group_jid: z.string().optional().describe('(Main group only) JID of the group to schedule the task for. Defaults to the current group.'),
  },
  async (args) => {
    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      if (/[Zz]$/.test(args.schedule_value) || /[+-]\d{2}:\d{2}$/.test(args.schedule_value)) {
        return {
          content: [{ type: 'text' as const, text: `Timestamp must be local time without timezone suffix. Got "${args.schedule_value}" — use format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [{ type: 'text' as const, text: `Invalid timestamp: "${args.schedule_value}". Use local time format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
    }

    // Non-main groups can only schedule for themselves
    const targetJid = isMain && args.target_group_jid ? args.target_group_jid : chatJid;

    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const data = {
      type: 'schedule_task',
      taskId,
      prompt: args.prompt,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Task ${taskId} scheduled: ${args.schedule_type} - ${args.schedule_value}` }],
    };
  },
);

server.tool(
  'list_tasks',
  "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter((t: { groupFolder: string }) => t.groupFolder === groupFolder);

      if (tasks.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const formatted = tasks
        .map(
          (t: { id: string; prompt: string; schedule_type: string; schedule_value: string; status: string; next_run: string }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return { content: [{ type: 'text' as const, text: `Scheduled tasks:\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} pause requested.` }] };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} resume requested.` }] };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} cancellation requested.` }] };
  },
);

server.tool(
  'update_task',
  'Update an existing scheduled task. Only provided fields are changed; omitted fields stay the same.',
  {
    task_id: z.string().describe('The task ID to update'),
    prompt: z.string().optional().describe('New prompt for the task'),
    schedule_type: z.enum(['cron', 'interval', 'once']).optional().describe('New schedule type'),
    schedule_value: z.string().optional().describe('New schedule value (see schedule_task for format)'),
  },
  async (args) => {
    // Validate schedule_value if provided
    if (args.schedule_type === 'cron' || (!args.schedule_type && args.schedule_value)) {
      if (args.schedule_value) {
        try {
          CronExpressionParser.parse(args.schedule_value);
        } catch {
          return {
            content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}".` }],
            isError: true,
          };
        }
      }
    }
    if (args.schedule_type === 'interval' && args.schedule_value) {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}".` }],
          isError: true,
        };
      }
    }

    const data: Record<string, string | undefined> = {
      type: 'update_task',
      taskId: args.task_id,
      groupFolder,
      isMain: String(isMain),
      timestamp: new Date().toISOString(),
    };
    if (args.prompt !== undefined) data.prompt = args.prompt;
    if (args.schedule_type !== undefined) data.schedule_type = args.schedule_type;
    if (args.schedule_value !== undefined) data.schedule_value = args.schedule_value;

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} update requested.` }] };
  },
);

server.tool(
  'register_group',
  `Register a new chat/group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name must be channel-prefixed: "{channel}_{group-name}" (e.g., "whatsapp_family-chat", "telegram_dev-team", "discord_general"). Use lowercase with hyphens for the group name part.`,
  {
    jid: z.string().describe('The chat JID (e.g., "120363336345536173@g.us", "tg:-1001234567890", "dc:1234567890123456")'),
    name: z.string().describe('Display name for the group'),
    folder: z.string().describe('Channel-prefixed folder name (e.g., "whatsapp_family-chat", "telegram_dev-team")'),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can register new groups.' }],
        isError: true,
      };
    }

    const data = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Group "${args.name}" registered. It will start receiving messages immediately.` }],
    };
  },
);

server.tool(
  'upload_document',
  'Upload a document file to Paperless-ngx for archival and OCR processing. Use this when emails contain document attachments (PDFs, scanned documents, invoices, contracts, receipts, letters). Do NOT upload non-document files like signatures, logos, or calendar invites.',
  {
    file_path: z.string().describe('Absolute container path to the document file (e.g. /workspace/group/attachments/email-123-invoice.pdf)'),
    title: z.string().optional().describe('Document title. If omitted, Paperless uses the filename.'),
    correspondent: z.string().optional().describe('Name of the sender/company (e.g. "Deutsche Telekom")'),
    document_type: z.string().optional().describe('Document type (e.g. "Rechnung", "Vertrag", "Quittung", "Brief")'),
    tags: z.array(z.string()).optional().describe('Tags to apply (e.g. ["Finanzen", "2026"])'),
    created: z.string().optional().describe('Document date in YYYY-MM-DD format'),
  },
  async (args) => {
    const apiUrl = process.env.PAPERLESS_API_URL;
    const apiToken = process.env.PAPERLESS_API_TOKEN;

    if (!apiUrl || !apiToken) {
      return {
        content: [{ type: 'text' as const, text: 'Paperless-ngx not configured (PAPERLESS_API_URL / PAPERLESS_API_TOKEN missing).' }],
        isError: true,
      };
    }

    if (!fs.existsSync(args.file_path)) {
      return {
        content: [{ type: 'text' as const, text: `File not found: ${args.file_path}` }],
        isError: true,
      };
    }

    try {
      const fileBuffer = fs.readFileSync(args.file_path);
      const fileName = path.basename(args.file_path);

      const formData = new FormData();
      formData.append('document', new Blob([fileBuffer]), fileName);
      if (args.title) formData.append('title', args.title);
      if (args.correspondent) formData.append('correspondent', args.correspondent);
      if (args.document_type) formData.append('document_type', args.document_type);
      if (args.tags) {
        for (const tag of args.tags) formData.append('tags', tag);
      }
      if (args.created) formData.append('created', args.created);

      const response = await fetch(`${apiUrl}/api/documents/post_document/`, {
        method: 'POST',
        headers: { 'Authorization': `Token ${apiToken}` },
        body: formData,
      });

      if (!response.ok) {
        const body = await response.text();
        return {
          content: [{ type: 'text' as const, text: `Paperless upload failed (${response.status}): ${body}` }],
          isError: true,
        };
      }

      const result = await response.json();
      return {
        content: [{ type: 'text' as const, text: `Document uploaded to Paperless-ngx. Task ID: ${result}` }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Upload error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'resolve_host_path',
  'Resolve a container-local file path to its absolute host filesystem path. Use this when passing file paths to external MCP servers (e.g. ai-brain screenshot_path) that run on the host and need the real filesystem path.',
  {
    container_path: z.string().describe('Path relative to /workspace/group/ (e.g. "attachments/img-1234.jpg")'),
  },
  async (args) => {
    if (!hostGroupsDir) {
      return {
        content: [{ type: 'text' as const, text: 'Host path resolution not available (NANOCLAW_HOST_GROUPS_DIR not set).' }],
        isError: true,
      };
    }

    const hostPath = path.join(hostGroupsDir, groupFolder, args.container_path);

    // Verify the file exists in the container to catch typos early
    const containerFullPath = path.join('/workspace/group', args.container_path);
    if (!fs.existsSync(containerFullPath)) {
      return {
        content: [{ type: 'text' as const, text: `File not found in container: ${containerFullPath}` }],
        isError: true,
      };
    }

    return {
      content: [{ type: 'text' as const, text: hostPath }],
    };
  },
);

server.tool(
  'list_emails',
  `List emails from an IMAP inbox. Use this to check for new or unread emails.`,
  {
    account: z.string().describe('Email account address (e.g., "info@crewtex.de")'),
    folder: z.string().optional().describe('IMAP folder (default: "INBOX")'),
    limit: z.number().optional().describe('Max emails to return (default: 10)'),
    unread_only: z.boolean().optional().describe('Only show unread emails (default: false)'),
  },
  async (args) => {
    const data = {
      type: 'list_emails',
      account: args.account,
      folder: args.folder || 'INBOX',
      limit: args.limit || 10,
      unreadOnly: args.unread_only || false,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    // Write request and wait for response
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const requestFile = path.join(TASKS_DIR, `${requestId}.json`);
    const responseFile = path.join(IPC_DIR, 'responses', `${requestId}.json`);
    
    fs.mkdirSync(path.join(IPC_DIR, 'responses'), { recursive: true });
    fs.writeFileSync(requestFile, JSON.stringify({ ...data, requestId }));

    // Poll for response (max 15 seconds)
    const maxWait = 15000;
    const pollInterval = 200;
    let waited = 0;
    
    while (waited < maxWait) {
      if (fs.existsSync(responseFile)) {
        const response = JSON.parse(fs.readFileSync(responseFile, 'utf-8'));
        fs.unlinkSync(responseFile);
        
        if (response.error) {
          return { content: [{ type: 'text' as const, text: `Error: ${response.error}` }], isError: true };
        }
        
        return { content: [{ type: 'text' as const, text: response.result }] };
      }
      await new Promise(r => setTimeout(r, pollInterval));
      waited += pollInterval;
    }

    return { content: [{ type: 'text' as const, text: 'Timeout waiting for email list' }], isError: true };
  },
);

server.tool(
  'email_action',
  `Perform an action on an email in the inbox. Use this to delete or archive emails after the user confirms.
IMPORTANT: Always ask the user for confirmation before deleting emails!`,
  {
    action: z.enum(['delete', 'archive', 'mark_read', 'mark_unread']).describe('Action to perform'),
    message_id: z.string().describe('The email Message-ID header (e.g., "<abc123@mail.example.com>")'),
    account: z.string().describe('Email account address (e.g., "info@crewtex.de")'),
    archive_folder: z.string().optional().describe('Folder to move to when archiving (default: "Archive")'),
  },
  async (args) => {
    const data = {
      type: 'email_action',
      action: args.action,
      messageId: args.message_id,
      account: args.account,
      archiveFolder: args.archive_folder || 'Archive',
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    const actionVerb = args.action === 'delete' ? 'Deletion' : 
                       args.action === 'archive' ? 'Archive' :
                       args.action === 'mark_read' ? 'Mark as read' : 'Mark as unread';

    return { content: [{ type: 'text' as const, text: `${actionVerb} requested for email ${args.message_id}` }] };
  },
);

server.tool(
  'send_email',
  `Send an email via SMTP. Use this to compose and send emails on behalf of the user.
IMPORTANT: Always confirm with the user before sending an email! Show them the recipient, subject, and body first.`,
  {
    to: z.union([z.string(), z.array(z.string())]).describe('Recipient email address(es)'),
    subject: z.string().describe('Email subject line'),
    body: z.string().describe('Plain text email body'),
    from: z.string().optional().describe('Sender address (defaults to the configured account address)'),
    html: z.string().optional().describe('HTML email body (optional, sent alongside plain text)'),
    reply_to: z.string().optional().describe('Reply-To address'),
    account: z.string().optional().describe('Email account to send from (e.g., "info@crewtex.de"). Defaults to first configured account.'),
  },
  async (args) => {
    const data = {
      type: 'send_email',
      to: args.to,
      subject: args.subject,
      body: args.body,
      from: args.from,
      html: args.html,
      replyTo: args.reply_to,
      account: args.account,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    const recipients = Array.isArray(args.to) ? args.to.join(', ') : args.to;
    return { content: [{ type: 'text' as const, text: `Email to ${recipients} queued for sending.` }] };
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
