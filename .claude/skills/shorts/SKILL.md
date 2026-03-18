# Shorts Video Generator

Generate YouTube Shorts / TikTok videos with AI voiceover and stock footage.

## Quick Start

```bash
cd /workspace/group/shorts

# English (default)
python3 generate_short.py --thema "Time Management" --skript "Your script here..."

# German
python3 generate_short.py --thema "Zeitmanagement" --skript "Dein Skript hier..." --lang german

# Other languages
python3 generate_short.py --thema "Topic" --skript "..." --lang japanese
```

## Supported Languages

| Language | Flag | Auto Voice |
|----------|------|------------|
| `english` | 🇬🇧 | ryan |
| `german` | 🇩🇪 | ryan |
| `chinese` | 🇨🇳 | vivian |
| `japanese` | 🇯🇵 | ono_anna |
| `korean` | 🇰🇷 | sohee |
| `french` | 🇫🇷 | serena |
| `spanish` | 🇪🇸 | aiden |
| `italian` | 🇮🇹 | serena |
| `portuguese` | 🇵🇹 | ryan |
| `russian` | 🇷🇺 | ryan |

## TTS Options

### 1. ElevenLabs (Cloud - Best Quality)
- Exact word timestamps for perfect subtitle sync
- Requires API key
```bash
python3 generate_short.py --thema "Topic" --skript "..." --tts elevenlabs
```

### 2. Qwen3-TTS (Local - Free, Default)
- 10 languages, auto voice selection
- Running on `http://100.97.97.130:8090`
```bash
python3 generate_short.py --thema "Topic" --skript "..." --tts qwen3 --lang german
```

### 3. Chatterbox (Local - Voice Cloning)
- Emotion control, voice cloning
- Running on `http://100.97.97.130:8091`
```bash
python3 generate_short.py --thema "Topic" --skript "..." --tts chatterbox
```

## Available Voices (Qwen3)

| Voice | Description | Best For |
|-------|-------------|----------|
| `ryan` | Dynamic male, strong rhythm | English content |
| `aiden` | Sunny American male | Casual English |
| `serena` | Warm, gentle female | Soft content |
| `vivian` | Bright, edgy female | Energetic content |
| `ono_anna` | Playful Japanese female | Japanese |
| `sohee` | Warm Korean female | Korean |

## Configuration

Edit `/workspace/group/shorts/.env`:

```bash
# Default TTS service
TTS_SERVICE=elevenlabs  # or: qwen3, chatterbox

# ElevenLabs
ELEVENLABS_API_KEY=your_key
ELEVENLABS_VOICE_ID=TxGEqnHWrfWFTfGW9XjX

# Qwen3-TTS
QWEN3_URL=http://100.97.97.130:8090
QWEN3_SPEAKER=ryan
QWEN3_LANGUAGE=english

# Chatterbox
CHATTERBOX_URL=http://100.97.97.130:8091

# Pexels for background videos
PEXELS_API_KEY=your_key
```

## Rendering

After generation, render with Remotion:

```bash
cd ~/Development/my-video
npx remotion render Short out/your_topic.mp4 \
  --duration-in-frames=XXX \
  --props='{"audioFile":"...", "bgVideo":"...", "skript":"..."}'
```

The script outputs the exact command to run.

## TTS API (Direct Access)

Other agents can use the TTS services directly:

```bash
# Qwen3-TTS
curl -X POST http://100.97.97.130:8090/tts \
  -H "Content-Type: application/json" \
  -d '{"text":"Hello world","speaker":"ryan","language":"english"}' \
  -o speech.wav

# Chatterbox
curl -X POST http://100.97.97.130:8091/tts \
  -H "Content-Type: application/json" \
  -d '{"text":"Hello world"}' \
  -o speech.wav

# Get available voices
curl http://100.97.97.130:8090/info
```

## Service Management

TTS services are **OFF by default** to save GPU memory. Start them on-demand:

```bash
# Check status
curl http://host.docker.internal:8089/status

# Start service (wait 10-15s for model load)
curl -X POST http://host.docker.internal:8089/qwen3/start
curl -X POST http://host.docker.internal:8089/chatterbox/start

# Stop when done
curl -X POST http://host.docker.internal:8089/qwen3/stop
curl -X POST http://host.docker.internal:8089/chatterbox/stop
```

**Workflow for Shorts:**
1. Start the TTS service you need
2. Wait 10-15 seconds for model to load
3. Run `generate_short.py`
4. Stop the service when done

## File Locations

- Script: `/workspace/group/shorts/generate_short.py`
- Config: `/workspace/group/shorts/.env`
- Output: `~/Development/my-video/out/<topic>/`
- Audio: `~/Development/my-video/public/audio/`
- Backgrounds: `~/Development/my-video/public/backgrounds/`
