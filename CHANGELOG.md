# Changelog

## [Unreleased]

### Added
- **Grok Imagine Video**: `--video grok` option in generate_short.py — xAI video generation as alternative to Runway (up to 15s, 720p)
- **Telegram Reply Context**: When users reply to a message, the agent now sees the quoted message context in format `[Replying to Name: "quoted text"]`
- Pool bot audio/voice sending support (sendPoolAudio, sendPoolVoice)

## v1.3.1 (2026-03-20)

### Command Center Integration
- **API Endpoints**: Skills, Tasks, Health, Updates via webhook server
- **Upstream Merge**: Security fixes, Docker timeout improvements from v1.2.19

### Security
- Stop logging user prompt content on container errors (upstream)

### Improvements  
- Faster container restarts via reduced Docker stop timeout (upstream)

All notable changes to NanoClaw will be documented in this file.

## [1.7.1](https://github.com/qwibitai/nanoclaw/compare/v1.7.0...v1.7.1)

- **feat:** Peppermint-Verwaltung MCP server — agents can now access Verwaltung tools (`peppermint-verwaltung`) via container
- **fix:** Email account IDs added to henneberg (15), department (16), info (17) CLAUDE.md files for `attach-email-to-task-tool`
- **chore:** Code formatting cleanup in email.ts, ipc.ts

## [1.7.0](https://github.com/qwibitai/nanoclaw/compare/v1.6.0...v1.7.0)

- **feat:** `read_email` MCP tool — agents can read full email body + attachments by IMAP UID
- **feat:** `forward_email` MCP tool — agents can forward emails with original attachments via SMTP
- **fix:** Agent memory system — switch `callClaude()` to Agent SDK for OAuth-compatible LLM calls, add raw fallback on failure
- **fix:** `walkBodyStructure` MIME type parsing — ImapFlow returns `"text/plain"` combined, not split `type`/`subtype`. This caused empty email bodies in all tools.
- **refactor:** `createImapClient()` shared helper for IMAP connection setup
- **refactor:** `buildSmtpTransport()` exported from email-sender for reuse

## [1.6.0](https://github.com/qwibitai/nanoclaw/compare/v1.5.1...v1.6.0)

- **feat:** Telegram voice message transcription — auto-download OGG, transcribe via local Whisper (port 8092), inject `[Voice: ...]` into chat context
- **fix:** Telegram test suite — 27 tests fixed by resolving `seenMessages` dedup state leak across tests (auto-incrementing messageId)
- **merge:** Upstream remote-control feature integrated

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

