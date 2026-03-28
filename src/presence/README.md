# Presence Tracker Module

WhatsApp presence tracking as an optional NanoClaw feature. Monitors when contacts go online/offline and sends alerts to a Telegram group.

## Configuration

Add to your `.env`:

```env
# Enable presence tracker
PRESENCE_TRACKER_ENABLED=true

# Telegram chat ID for alerts (e.g., "tg:-5284494721")
PRESENCE_ALERT_CHAT_ID=tg:-5284494721
```

## First-Time Setup

On first run, a QR code will be displayed in the console. Scan it with WhatsApp:

1. Open WhatsApp on your phone
2. Go to **Settings > Linked Devices > Link a Device**
3. Scan the QR code

The authentication is stored in `store/presence-auth/`.

## IPC Commands

Agents can use these commands via IPC:

### `presence_track`
Add a number to tracking.

```json
{
  "type": "presence_track",
  "phone": "491234567890",
  "label": "Max",
  "requestId": "track-123"
}
```

### `presence_untrack`
Remove a number from tracking.

```json
{
  "type": "presence_untrack",
  "phone": "491234567890",
  "requestId": "untrack-123"
}
```

### `presence_list`
List all tracked numbers.

```json
{
  "type": "presence_list",
  "requestId": "list-123"
}
```

### `presence_stats`
Get usage statistics for a number.

```json
{
  "type": "presence_stats",
  "phone": "491234567890",
  "days": 7,
  "requestId": "stats-123"
}
```

### `presence_events`
Get recent presence events.

```json
{
  "type": "presence_events",
  "phone": "491234567890",
  "limit": 20,
  "requestId": "events-123"
}
```

### `presence_status`
Check tracker connection status.

```json
{
  "type": "presence_status",
  "requestId": "status-123"
}
```

## Architecture

```
src/presence/
├── index.ts      # Module entry point, initialization
├── tracker.ts    # PresenceTracker class (WhatsApp connection)
├── db.ts         # SQLite database layer
├── alerts.ts     # Telegram alert integration
├── types.ts      # Type definitions
└── README.md     # This file
```

## Data Storage

- **Authentication**: `store/presence-auth/` (WhatsApp credentials)
- **Database**: `store/presence-tracker.db` (SQLite)

The database stores:
- `tracked_numbers` - JIDs being monitored
- `presence_events` - Historical online/offline events

## Alerts

When enabled, sends HTML-formatted messages to the configured Telegram group:

- 🟢 **Max** online @ 14:30:45
- 🔴 **Max** offline @ 15:15:22 (45min Session)
