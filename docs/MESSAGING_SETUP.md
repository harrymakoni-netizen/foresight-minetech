# Messaging setup (Foresight Lite)

Foresight never sends a real message unless an operator deliberately configures it. The default is **dry-run**: every message is written to the outbox and shown as "Dry run: not sent".

## Architecture decision

The messaging service (`npm run worker:messaging`, `services/messaging/service.ts`) is an always-on Node process that **shares the server modules and database** with the web app (`lib/server/checkins.ts`, `messaging.ts`, `gateway.ts`). It does not call internal HTTP endpoints. Webhooks are received by the web app (`/api/messaging/*`), which stores inbound messages and queues replies; the service sends the outbox, runs the escalation scheduler, marks receipts as unconfirmed after the deadline and polls gateway health. Every loop writes a `messaging-service` heartbeat; Underground now shows "Escalation scheduler stopped" if it is older than 90 s, and `GET /api/messaging/health` returns 503 for an external uptime monitor (needed to page someone when both the service and messaging are down).

## Modes (server-enforced)

| `MESSAGING_MODE` | Effect |
| --- | --- |
| `dry-run` (default; also used for any unknown value) | Outbox only. Status `dry-run`. Providers are never called. |
| `allow-list` | Sends only to numbers in `MESSAGING_TEST_NUMBERS`; others are `blocked`. |
| `live` | Also requires an **administrator** to enable live messaging for the workspace (`POST /api/workspace/messaging/live`). Until then messages are `blocked`. Never set by automation. |

Status history per message: `queued → accepted → delivered | failed | unconfirmed` (plus `dry-run`, `blocked`). "Accepted" means a provider took it; only a delivery receipt makes it "delivered". Without a receipt after `unconfirmedAfterMinutes` (default 15) it becomes `unconfirmed`; a late receipt still moves it to `delivered`. A failed WhatsApp message with an SMS fallback queues an SMS copy linked as `failover-of`.

## SMSGate (Android phone with a local SIM)

1. Install SMSGate on an Android phone with an Econet or NetOne SIM. Choose cloud mode (deployed system) or local mode (laptop demo on the same Wi-Fi).
2. Set `SMSGATE_URL` (cloud: `https://api.sms-gate.app/3rdparty/v1`; local: the phone's address shown in the app), and `SMSGATE_USERNAME`/`SMSGATE_PASSWORD` (or `SMSGATE_TOKEN`). Optional second phone: `SMSGATE_SECONDARY_*`.
3. Generate `SMSGATE_WEBHOOK_TOKEN` (≥ 24 random characters) and register webhooks for `sms:received`, `sms:delivered`, `sms:failed` (and optionally `system:ping`) pointing to `https://<host>/api/messaging/sms?token=<SMSGATE_WEBHOOK_TOKEN>`.
4. In Foresight, bind the gateway to your workspace: `POST /api/gateway {"provider":"smsgate","channelKey":"<deviceId or default>"}`.
5. Heartbeat: the service polls `GET {SMSGATE_URL}/health` every `SMSGATE_HEALTH_INTERVAL_MS`. Unreachable or `fail` → **Gateway offline**; battery below `SMSGATE_LOW_BATTERY_PERCENT` or `warn` → degraded. A new outage alerts administrators/supervisors once (WhatsApp first).

Request/response shapes follow the official SMSGate Python client 4.4.0 (`POST /messages` with `phoneNumbers`, `textMessage.text`, `withDeliveryReport`, client message `id`). SMSGate's own documentation site was not reachable from the build environment, so **webhook signing is not used**; the secret URL token (spec fallback) authenticates webhooks. Check the current SMSGate docs for a signing option and add it when available. The mock gateway (`npm run mock:gateway`) implements the same API and sends nothing.

## WhatsApp Cloud API (official only)

Set `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_GRAPH_VERSION` (from your Meta app; no version is assumed) and the webhook URL `https://<host>/api/messaging/whatsapp`. The GET handler answers Meta's `hub.challenge`; POST requires a valid `X-Hub-Signature-256` HMAC of the raw body with the app secret. Bind the number: `POST /api/gateway {"provider":"whatsapp","channelKey":"<phone_number_id>"}`.

Business-initiated messages (reminders, alerts) need **approved templates**, configured in `WHATSAPP_TEMPLATES` by Foresight template key. An unapproved or missing template fails honestly ("template not approved") and the SMS fallback is used where configured. Pricing is unconfirmed; message counts by purpose are in the message log for cost reporting. These field shapes have **not been verified against a real Meta test app** (no credentials were supplied and Meta's documentation host was unreachable from the build environment).

## Escalation ladder

Per workspace configuration (`messaging-config`; training defaults: grace 30 min, second interval 30 min, max shift 14 h):

| Due | Action |
| --- | --- |
| Expected return | Reminder to the miner (SMS, plus WhatsApp if the miner uses it) |
| + grace | Status **Return overdue**; buddy alerted |
| + second interval | Supervisors alerted (WhatsApp, SMS fallback); muster opens for the shaft |
| Human confirms missing | **Confirmed missing**; incident opened with check-in, messages and timeline |

Steps are rows in `escalation_steps` with a unique idempotency key per check-in and step; each is claimed, executed and marked in one transaction, so restarts and parallel schedulers never execute a step twice. Messages are queued with unique idempotency keys. Residual risk: if the process dies after a provider accepts a message but before the acceptance is recorded, the retry can send that one message again (the client message id is passed to SMSGate, which may or may not de-duplicate).

## Personal data

Phone numbers are sealed with AES-256-GCM (`FORESIGHT_PERSONAL_DATA_KEY`) and looked up by keyed hash. Viewers and reporters never receive numbers or inbound message text; supervisors see masked numbers. Consent is stored per person with history; `STOP` withdraws consent and records a removal request.

## Test with your own phones

1. Add yourself in Records → People and musters with your number; record consent (or reply YES).
2. Set `MESSAGING_MODE=allow-list` and `MESSAGING_TEST_NUMBERS=<your numbers>`; restart web and messaging service.
3. Send `IN` (WhatsApp) or `IN 1 1430 <buddy>` (SMS). Watch Underground now and Records → Messages.
