# Feishu / Lark outbound notifications

MindFS can push session and scheduled-task events to Feishu (Lark) in addition to Web Push and `notify-script`.

This is **outbound push only** (session done / need input / scheduled done|failed). It is inspired by Codeg’s Lark channel send path (tenant token + IM API / interactive cards), but does not implement bidirectional chat control.

## Configuration

Any one of the following enables Feishu notify when credentials are complete:

### 1) Bot webhook (simplest)

File `%AppData%/mindfs/feishu-notify.json` (or `~/.config/mindfs/feishu-notify.json`):

```json
{
  "enabled": true,
  "webhook_url": "https://open.feishu.cn/open-apis/bot/v2/hook/xxxxxxxx"
}
```

Or flags / env:

- `--feishu-webhook` / `MINDFS_FEISHU_WEBHOOK`

### 2) App + chat id (REST IM API)

```json
{
  "enabled": true,
  "app_id": "cli_xxx",
  "app_secret": "xxx",
  "chat_id": "oc_xxx"
}
```

Or:

- `--feishu-app-id` / `MINDFS_FEISHU_APP_ID`
- `--feishu-app-secret` / `MINDFS_FEISHU_APP_SECRET`
- `--feishu-chat-id` / `MINDFS_FEISHU_CHAT_ID`

App mode uses:

1. `POST /open-apis/auth/v3/tenant_access_token/internal`
2. `POST /open-apis/im/v1/messages?receive_id_type=chat_id`

### Optional event filter

```json
{
  "enabled": true,
  "webhook_url": "...",
  "events": ["session.done", "session.ask_user", "scheduled.done", "scheduled.failed"]
}
```

Empty `events` means all types.

## Event sources

Same fan-out as Web Push / notify-script (`AppContext.notifyPayload`):

- `session.done`
- `session.ask_user`
- `scheduled.done`
- `scheduled.failed`

## Message format

Interactive card (`msg_type=interactive`) with title/body from the shared `notify.Payload` model.
