# Changelog

All notable changes to NanoClaw will be documented in this file.

## [1.5.1](https://github.com/qwibitai/nanoclaw/compare/v1.5.0...v1.5.1)

- **refactor:** Extract `sendMediaFile()` + `dispatchIpcMessage()` helpers in IPC — deduplicate 4x repeated media send pattern
- **refactor:** Extract `handleIncomingMessage()` from inline `main()` callback in index.ts
- **refactor:** Add `requireChannelMethod()` helper to replace IPC deps boilerplate
- **refactor:** Split `buildVolumeMounts()` into `prepareGroupEnvironment()` (filesystem setup) + pure mount config
- **cleanup:** Remove unused `escapeXml`/`formatMessages` re-export from index.ts

## [1.5.0](https://github.com/qwibitai/nanoclaw/compare/v1.4.0...v1.5.0)

- **feat:** Telegram video sending — `send_video` MCP tool + IPC type + channel method + pool bot support
- **feat:** Telegram document sending — `send_document` MCP tool for PDFs, ZIPs, and any downloadable files
- **feat:** Local TTS services integration (Qwen3-TTS, Chatterbox) with on-demand control API

## [1.4.0](https://github.com/qwibitai/nanoclaw/compare/v1.3.1...v1.4.0)

- **feat:** IPC `list_emails` and `read_email` commands — agents can read emails from IMAP inboxes
- **feat:** OAuth2 authentication for email accounts (XOAUTH2 SMTP/IMAP)
- **feat:** Email accounts registry with multi-account support
- **feat:** Infra-monitor script for server health checks

## [1.3.1](https://github.com/qwibitai/nanoclaw/compare/v1.3.0...v1.3.1)

- **fix:** Telegram 409 polling conflict on restart — call `deleteWebhook` before `bot.start()`
- **feat:** SSH key mount (read-only) for container agents — enables `git push` from containers
- **feat:** Git author config injected into containers via env vars
- **feat:** `openssh-client` added to container image

## [1.3.0](https://github.com/qwibitai/nanoclaw/compare/v1.2.0...v1.3.0)

- **feat:** Telegram multi-bot support — run multiple bots via `TELEGRAM_EXTRA_BOTS` env var
- **feat:** Message deduplication when multiple bots share the same group
- **feat:** Auto-routing sends replies via the correct bot per group

## [1.2.0](https://github.com/qwibitai/nanoclaw/compare/v1.1.6...v1.2.0)

[BREAKING] WhatsApp removed from core, now a skill. Run `/add-whatsapp` to re-add (existing auth/groups preserved).
- **fix:** Prevent scheduled tasks from executing twice when container runtime exceeds poll interval (#138, #669)
