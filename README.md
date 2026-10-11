# whatsapp-adapter

WhatsApp Web session (Baileys) for the PlayTalk support inbox. Same HTTP contract as [bale-adapter](https://github.com/PlayTalk-ir/bale-adapter): inbox feed, reply-only `POST /v1/messages`, bearer token.

Public URL: **https://whatsapp-adaptor.boostsho.ir** (Cloudflare DNS only → nginx → `127.0.0.1:8788` on `steach-stage-vps`).

The support panel (`tech-support`) polls this host. QR linking is shown in the panel's Settings tab (`GET /v1/session`).

## Local

```bash
cp .env.example .env
# put a token in .env.secrets or export WA_ADAPTER_API_TOKENS
npm ci
npm start    # http://127.0.0.1:8788
npm test
```

Scan the QR from `GET /v1/session` (`qr_data_url`) with the intake phone: WhatsApp → Linked devices.

## Deploy

Push to `main`. GitHub Actions SSHes to the stage VPS, `git pull`s `/opt/whatsapp-adapter`, and restarts `whatsapp-adapter.service`.

Repo secrets and variables (same names as bale-adapter):

| Name | Kind | Purpose |
|---|---|---|
| `VPS_DEPLOY_KEY` | secret | SSH private key for `root` on the stage VPS |
| `VPS_HOST` | variable | `5.42.223.209` |
| `VPS_PORT` | variable | `3939` |

The session and the API token survive deploys:

- Session: `/opt/whatsapp-adapter/data/` (gitignored)
- Token: `/opt/whatsapp-adapter/.env.secrets` (`WA_ADAPTER_API_TOKENS`), created once, never overwritten

`WA_SENDING_PAUSED=true` in `.env` stops sends. Inbound messages still arrive.

## HTTP

| Method | Path | Auth |
|---|---|---|
| GET | `/healthz` | no |
| GET | `/readyz`, `/v1/session` | bearer |
| POST | `/v1/session/logout` | bearer |
| GET | `/v1/inbox/events`, `/v1/inbox/chats/:id/history` | bearer |
| POST | `/v1/messages` | bearer, `mode` must be `reply` |
| GET | `/v1/messages/:id` | bearer |
