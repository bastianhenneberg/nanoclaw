# Changelog

All notable changes to NanoClaw will be documented in this file.

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
