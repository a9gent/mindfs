# Feishu / Lark outbound notifications

MindFS can push session and scheduled-task events to Feishu (Lark) in addition to Web Push and `notify-script`.

This is **outbound push only** (session done / need input / scheduled done|failed). It is inspired by Codeg’s Lark channel send path (tenant token + IM API / interactive cards), but does not implement bidirectional chat control.

## Configure in the UI (recommended)

Open the file-tree **⋯ menu** → **飞书通知 / Feishu notify**:

1. Enable the toggle
2. Paste a Feishu group bot **Webhook URL**
3. Click **Save**
4. Click **测试飞书通道 / Test Feishu channel** to verify delivery

While notify is **enabled**, webhook/app credentials are **read-only**. Turn notify off, edit, save, then enable again.

Changes are written to `%AppData%/mindfs/feishu-notify.json` (or `~/.config/mindfs/feishu-notify.json`) and applied **live** — no process restart.

Optional app credentials (App ID / App Secret / Chat ID) are under the expandable **App credentials** section in the same panel. `app_secret` is never returned by the API; leave the field blank to keep the stored secret.

### HTTP API

| Method | Path | Notes |
|--------|------|--------|
| `GET` | `/api/feishu-notify` | Public config (`has_app_secret`, no secret value) |
| `PUT` / `POST` | `/api/feishu-notify` | Partial update; omit fields to keep; empty `app_secret` clears |
| `POST` | `/api/feishu-notify/test` | Send a test interactive card |

## File / env / flags (optional bootstrap)

You can still seed config outside the UI:

### 1) Bot webhook

```json
{
  "enabled": true,
  "webhook_url": "https://open.feishu.cn/open-apis/bot/v2/hook/xxxxxxxx"
}
```

Or flags / env (applied once at startup, then overridable from the UI):

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
