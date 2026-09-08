# XTECH group notifications

When a support ticket is created, CompanySys announces it in an internal
WhatsApp group through XTECH (`app.x-tech.my`).

Configured in the app: **Settings → XTECH**. Stored in `app_settings`, not
`.env`; the env vars of the same name remain a fallback.

## The request contract

Established from XTECH's own validation response on 2026-08-28, not from docs.

```http
POST https://app.x-tech.my/api/xtech-send-message
Content-Type: application/json
```

```json
{
  "token": "<api token>",
  "to": "601155849969",
  "message": "🎫 New support ticket — SC-202608-0042\n…"
}
```

Three things that are easy to get wrong, each of which XTECH rejects:

| | Correct | Wrong |
|---|---|---|
| Token | in the **body** as `token` | an `Authorization: Bearer` header → `token: Required` |
| Text field | `message` | `text` → `message: Required` |
| Recipient | bare digits, `601155849969` | a JID, `601155849969@s.whatsapp.net` → `Invalid number or lid format` |

`normaliseRecipient()` in `services/groupNotifyService.js` trims a pasted JID to
digits, so either form can be typed into Settings.

A success looks like:

```json
{"result":"Message queued for sending to 601155849969","status":"connected","connected":true,"messageId":5093445}
```

## Groups ARE supported — via a different endpoint (2026-09-02)

The section below is kept because it documents a real result, but it is no
longer the whole story. `app_settings.xtech_api_url` now points at

```
https://app.x-tech.my/api/wa-send-group-message
```

and deliveries addressed to the group id `120363046735396444` come back `200`
with the outbox row marked `SENT`. So "announce to the internal group" is a
group message again, not a list of people.

`xtech-send-message` (the personal endpoint) still rejects a group id exactly as
described below — the two endpoints take different recipients. Check which URL
is saved in Settings before concluding anything about what XTECH can address.

## Groups are not supported by this endpoint — the PERSONAL endpoint, superseded above

Tested against live XTECH on 2026-08-28:

| `to` | Result |
|---|---|
| `601155849969` (12-digit phone) | `200` — queued, `messageId 5093445` |
| `120363046735396444@g.us` (group JID) | `400` — `Invalid number or lid format` |
| `120363046735396444` (group id, bare) | `400` — `Invalid number or lid format` |

The validator wants a number or a LID, both of which identify a **person**. An
18-digit group id matches neither.

So "announce to the internal group" is implemented as **announce to a list of
people**. `xtech_group_id` holds one or more numbers separated by commas or new
lines; each gets its own outbox row, so a retry after a partial failure
re-sends only to whoever actually failed rather than duplicating to everyone.

If XTECH does add a groups endpoint, the change is `send()` plus the Settings
label — the queueing and retry machinery is unaffected.

## Never send from a developer machine

`app_settings` holds the same live token and the same real group id on every
machine, and `webhookService.flushSoon()` drains the outbox in-process the
moment a ticket is created — so **creating a test ticket on a laptop sends a
real WhatsApp message to the team's group**. No cron required. This has
happened three times.

Set `WHATSAPP_DRY_RUN=1` in a development `.env`. The drain then skips WhatsApp
rows and leaves them queued, the same as an unconfigured channel — nothing is
lost and no retries are burned.

It is opt-in rather than opt-out deliberately: blocking unless
`NODE_ENV=production` would silently mute production on any box that does not
set `NODE_ENV`, and this repo does not set it anywhere.

## Verified end to end

Creating a ticket queues one `WHATSAPP` row per recipient and
`jobs/webhookSender.js` delivers it: ticket `SC-202608-0040` → `200`, outbox
row `SENT`.

## The message is editable

**Settings → The message.** A template with `{placeholder}` fields, a live
preview rendered by the server (so what you see is what gets sent), and a reset
button.

Placeholders: `ticket_key`, `title`, `project`, `company`, `request_type`,
`priority`, `tech_lead`, `assigned_dev`, `reported_by`, `status`, `app_url`.

One rule worth knowing: **a line whose placeholders are all empty is dropped.**
So `Reported by: {reported_by}` leaves nothing behind on a ticket a PM typed in,
rather than a dangling label. A line with some values present keeps them, and a
`·` stranded by an empty neighbour is tidied away.

Saving the default text verbatim stores nothing, so the message keeps tracking
the default if it is ever improved.

## Delivery

Messages are queued into `webhook_deliveries` with `channel = 'WHATSAPP'`, in
the same transaction that creates the ticket, and sent by
`jobs/webhookSender.js` with the outbox's retry schedule. A XTECH outage delays
an announcement; it never fails the ticket or loses the message.

```
*/2 * * * * cd /path/to/CompanySysAPI && /usr/bin/node jobs/webhookSender.js >> logs/webhook.log 2>&1
```

## Open question

Whether XTECH offers a separate endpoint or parameter for groups — its
**Tutorial** section would say. Until then the person-list above is the
mechanism.
