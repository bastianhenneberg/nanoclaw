# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process with skill-based channel system. Channels (WhatsApp, Telegram, Slack, Discord, Gmail) are skills that self-register at startup. Messages route to Claude Agent SDK running in containers (Linux VMs). Each group has isolated filesystem and memory.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/registry.ts` | Channel registry (self-registration at startup) |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `container/skills/agent-browser.md` | Browser automation tool (available to all agents via Bash) |

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update-nanoclaw` | Bring upstream NanoClaw updates into a customized install |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch |
| `/get-qodo-rules` | Load org- and repo-level coding rules from Qodo before code tasks |
| `/shorts` | Generate YouTube Shorts/TikTok videos with AI voiceover (ElevenLabs, Qwen3-TTS, Chatterbox) |

## Local TTS & Whisper Services

Running on omarchy (from Docker containers use `host.docker.internal`):
- **Qwen3-TTS** (Port 8090): 10 languages, 9 voices, free
- **Chatterbox** (Port 8091): Voice cloning, emotion control
- **Whisper** (Port 8092): Transcription & word-level timestamps
- **Control API** (Port 8089): Start/stop services on demand

### Start Services On-Demand

TTS services are OFF by default to save GPU memory. Whisper runs always.

```bash
# Check status
curl http://host.docker.internal:8089/status

# Start TTS (wait ~10-15s for model load)
curl -X POST http://host.docker.internal:8089/qwen3/start
curl -X POST http://host.docker.internal:8089/chatterbox/start
curl -X POST http://host.docker.internal:8089/whisper/start

# Stop when done
curl -X POST http://host.docker.internal:8089/qwen3/stop
curl -X POST http://host.docker.internal:8089/chatterbox/stop
```

### Generate TTS

```bash
# Qwen3-TTS
curl -X POST http://host.docker.internal:8090/tts \
  -H "Content-Type: application/json" \
  -d '{"text":"Hello","speaker":"ryan","language":"english"}' -o speech.wav

# Chatterbox
curl -X POST http://host.docker.internal:8091/tts \
  -H "Content-Type: application/json" \
  -d '{"text":"Hello"}' -o speech.wav
```

### Whisper Transcription & Timestamps

```bash
# Transcribe audio
curl -X POST http://host.docker.internal:8092/transcribe \
  -F "audio=@voice.wav" | jq .

# Get word-level timestamps (for subtitle sync)
curl -X POST http://host.docker.internal:8092/timestamps \
  -F "audio=@speech.wav" | jq .

# Forced alignment (text + audio)
curl -X POST http://host.docker.internal:8092/align \
  -F "audio=@speech.wav" \
  -F "text=Your script text here" | jq .
```

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Service management:
```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # restart

# Linux (systemd)
systemctl --user start nanoclaw
systemctl --user stop nanoclaw
systemctl --user restart nanoclaw
```

## Troubleshooting

**WhatsApp not connecting after upgrade:** WhatsApp is now a separate channel fork, not bundled in core. Run `/add-whatsapp` (or `git remote add whatsapp https://github.com/qwibitai/nanoclaw-whatsapp.git && git fetch whatsapp main && (git merge whatsapp/main || { git checkout --theirs package-lock.json && git add package-lock.json && git merge --continue; }) && npm run build`) to install it. Existing auth credentials and groups are preserved.

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.
