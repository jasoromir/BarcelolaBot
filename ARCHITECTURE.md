# BarcelolaBot — Code Architecture Map

## What this file is / what it is not

**This file is** a code map: where things live in `app/src`, how the modules wire
together at boot, and the conventions you must follow when editing. It is written
for a coding session that needs to change behaviour without re-reading the whole
tree. References are `path:line` against the repo state of **2026-08-03** — line
numbers drift, treat them as "look here", not gospel.

**This file is not:**

| For this | Read |
|---|---|
| How to deploy, update live config, admin password, test-message rules, the whatsapp-web.js fork pin | `CLAUDE.md` |
| Start/stop/restart, health checks, troubleshooting, ban-prevention, session management, env vars, webhook setup | `OPERATIONS.md` |
| Project history (WhatsApp ban incident, re-link lifecycle, email alerts), required secrets, backlog | `HANDOFF.md` |
| Cloudflare tunnel setup for Wix webhooks | `CLOUDFLARE_TUNNEL.md` |

> **Freshness caveat:** emoji-reaction-based *customer* confirm/cancel landed in
> this same session (2026-08-03), touching `reminders/reactionHandler.ts`,
> `reminders/replyHandler.ts`, `reminders/reactionIntent.ts`,
> `reminders/bookingResponse.ts`, `whatsapp/client.ts`, `whatsapp/types.ts`.
> Line numbers in §3 are the most likely to have drifted. **Deployed to Railway
> on 2026-08-03** (deployment `efa62808`), with `client_response_notice` /
> `client_response_notify_phone` pushed to the prod config overlay and reloaded.
> Still **uncommitted to git** — the working tree carries these changes plus
> other pre-existing uncommitted work.

---

## 1. Stack & layout

- TypeScript ESM (`"type": "module"`); **imports use `.js` extensions** even for `.ts` sources.
- Node 20, `tsc` strict. Scripts (`app/package.json`): `dev` = `tsx watch src/index.ts`, `build` = `tsc`, `test` = `vitest run`, `typecheck` = `tsc --noEmit`.
- Runtime deps of note: `whatsapp-web.js` (forked pin — see CLAUDE.md), `puppeteer`/Chromium, `better-sqlite3`, `express`, `zod`, `js-yaml`, `node-cron`, `winston` + daily-rotate.
- No DI framework. A single hand-built `App` object (`app/src/app.ts`) is the container.

```
app/src
  index.ts            boot + wiring (the file to read first)
  app.ts              the App interface (DI container shape)
  scheduler.ts        node-cron registration
  types.ts            domain types (Tour, BookingSummary, JobName, ...)
  config/             zod schemas + YAML loader (with volume overlay)
  persistence/        better-sqlite3 stores; db.ts owns the whole schema
  whatsapp/           whatsapp-web.js adapter + typed interface
  wix/                Wix Bookings REST client + webhook parsing
  webhook/            bookingHandler (Wix booking → welcome DM + reminder row)
  reminders/          the customer reply/confirm/cancel pipeline
  jobs/               nightly/morning broadcasts + poller runners
  messaging/          message builders, DM sender, delivery notifier, helpers
  moderation/         group spam detector + enforcement
  http/               express server, admin API, webhook routes
  notify/             session monitor + Resend emailer
  log/                logger (winston + events table dual sink)
  control/            control_state kv service (pause, new-contact restriction)
  google/             service-account calendar auth + event fetch
  util/localTime.ts   timezone helpers
```

---

## 2. Boot & wiring — `app/src/index.ts`

Read this file top-to-bottom once; the order matters.

| Step | Line | Notes |
|---|---|---|
| `requireEnv` for 4 secrets | `index.ts:53-56` | `ADMIN_PASSWORD_HASH`, `SESSION_COOKIE_SECRET`, `WIX_API_KEY`, `WIX_SITE_ID`. Missing ⇒ `process.exit(1)`. |
| Paths | `index.ts:58-66` | `dataDir` (`DATA_DIR` or `./data`) → `session/`, `logs/`, `wabot.sqlite`, `config/` (overlay). Bundled config = `cwd/config`. |
| `openDatabase` + 13 stores | `index.ts:68-82` | All stores take the same `Database` handle. |
| Recover stale job rows | `index.ts:84-85` | `jobHistory.markStaleRunning(now-1h)`. |
| `createLogger` | `index.ts:87` | Needs `eventLog`, so it comes after the DB. |
| `loadConfig` | `index.ts:96` | `let config` — reassigned by `reloadConfig`. |
| `createWhatsAppClient` | `index.ts:98-111` | `onQrRaw` prints the QR to the terminal. |
| `createWixClient` | `index.ts:112` | |
| **Reconnect-stability gate** | `index.ts:128-136` | `RECONNECT_STABLE_COOLDOWN_MS = 60_000`; `isConnectedAndStable()` is what **every poller** checks — never raw `whatsapp.state()`. |
| `DirectMessageSender` | `index.ts:138-149` | Every dep is a getter so config reloads / control-state flips apply live. |
| `createDeliveryNotifier` | `index.ts:151-160` | `alertPhone: () => resolveGuidePhone(config.guides, 'ליאנה')`. |
| classifier / drafter | `index.ts:163-164` | Classifier always constructed; drafter only when `GEMINI_API_KEY` is set. |
| `createReminderRunner` | `index.ts:165-184` | `config: () => ({templates, tours})` live getter at `:170`. |
| Optional subsystems | see table below | Each is `null` in `App` when its config flag is absent/false. |
| `const app: App` | `index.ts:340-381` | `reloadConfig` at `:343-351` reassigns **both** the local `config` and `app.config`. |
| Reminder handlers | `index.ts:383-433` | Gated on `reminders.enabled`; registers `onIncomingDm` (`:410`) and `onReaction` (`:431`), then `reminderRunner.start()` (`:432`). |
| Moderation | `index.ts:438-469` | Gated on `moderation.enabled`; registers `onGroupMessage` + `onGroupJoin`. |
| Runner starts | `index.ts:471-508` | guideNotify, backfill (+ fire-and-forget `runWideSweep()` at `:492`), privateTourNotify. |
| Pending-DM drain on reconnect | `index.ts:517-545` | `RECONNECT_DRAIN_COOLDOWN_MS = 60_000`, re-checks state after the wait. Also mirrors state into `control_state.last_connect_state`. |
| HTTP server + listen | `index.ts:547-561` | `PORT` ‖ `HTTP_PORT` ‖ 3000. |
| `whatsapp.start()` | `index.ts:570` | Fire-and-forget; reconnects silently if a session exists. |
| `startScheduler(app)` | `index.ts:578` | Last. |

### Which config flag gates which subsystem

| Subsystem | Gate | Built at | `App` field when off |
|---|---|---|---|
| Reply + reaction handlers, reminder runner | `settings.reminders.enabled` | `index.ts:383` | `replyHandler`/`classifier` stay `null` |
| Reminder backfill sweep | `settings.reminders.backfill.enabled` | `index.ts:186-201` | `reminderBackfillRunner: null` |
| Guide pre-tour roster | `settings.guide_notify.enabled` | `index.ts:206-240` | `guideNotifyRunner: null` |
| Private-tour sync | `private_tours.enabled` **and** `.sync.enabled` **and** `GOOGLE_SERVICE_ACCOUNT_KEY_B64` **and** `GEMINI_API_KEY` | `index.ts:251-280` | `runPrivateTourSync: null` (warns on missing env, `:254`/`:260`) |
| Private-tour day-before notify | `private_tours.enabled` **and** `.notify.enabled` | `index.ts:282-301` | `privateTourNotifyRunner: null` |
| Session monitor / email alerts | `settings.notifications.enabled` | `index.ts:306-335` | `sessionMonitor: null` |
| Spam moderation | `settings.moderation.enabled` | `index.ts:438-469` | nothing registered |

`guidePhotosCollector` is hard-wired to `null` (`index.ts:377`) — guide photos are
fetched at nightly-job time instead, see `scheduler.ts:25`.

### `app/src/app.ts` — the container

`App` (`app.ts:31-77`) = `db`, `config`, `reloadConfig`, the 13 stores +
`controlState` service, `whatsapp`, `wix`, `dmSender`, `notifyDelivery`,
`logger`, 4 runners (3 nullable), `runPrivateTourSync`, `sessionMonitor`,
`guidePhotosCollector`, `replyHandler` (`app.ts:72`, exposed only so admin
`/simulate-reply` can inject synthetic DMs), `classifier` (`app.ts:74`),
`lastQrDataUrl`.

---

## 3. Customer reply pipeline — `app/src/reminders/`

### Files

| File | Role |
|---|---|
| `replyHandler.ts` | Inbound DM → debounce → classify → confirm/cancel/forward |
| `reactionHandler.ts` | Inbound reaction → customer confirm/cancel, or staff 👍-approves-draft |
| `reactionIntent.ts` | Hand-written emoji → `confirm`/`cancel` allowlist |
| `bookingResponse.ts` | **The shared confirm/cancel core**, used by both handlers |
| `classifier.ts` | Gemini intent classification of a Hebrew reply |
| `drafter.ts` | Gemini suggested-reply draft for worker forwards |
| `templates.ts` | `interpolate()` + all customer/worker message builders |
| `runner.ts` | Day-before reminder poller + T-120min no-reply digest |
| `schedule.ts` | `computeReminderSendAtMs` — when a reminder is due |
| `privateTourDetector.ts` | Is this calendar event a private tour? |
| `privateEventParser.ts` | Gemini extraction of fields from a free-text calendar event |

### Text DM flow — `replyHandler.ts`

1. **Debounce.** `handleIncoming` (`replyHandler.ts:357`) → `enqueue` (`:87`) buffers per phone and resets a `reply_debounce_seconds` timer. `debounceMs === 0` bypasses the buffer entirely (the path unit tests use).
2. **Merge.** `flush` (`:60-85`) joins buffered bodies with `\n`, keeps the **last** `messageId`, and marks the merged message `type:'media'` if *any* buffered message was non-chat (`:74`) so media signal is not lost.
3. **Lookup.** `processReply` (`:116`) normalizes the phone and calls `reminders.findActiveForReply(phone, nowIso)` (`:124`).
4. **Non-text branch** (`:131-162`). `isNonText = hasMedia===true || (type!==undefined && type!=='chat') || body.length===0`. Always forwards to the worker group via `forwardMediaToWorker` (`:379`) — a Hebrew heads-up plus a best-effort `forwardMessage` of the actual media. If there is no booking, also sends the throttled unmanaged-number reply. Audit note `non_text_<type>`.
5. **No active reminder** (`:164-202`). Sends `templates.unmanaged_number_reply`, throttled to once per hour per phone (`UNMANAGED_REPLY_THROTTLE_MS`, `:51`; in-memory map at `:58`). Audit note `no_active_reminder_replied` / `_throttled`.
6. **Classify** (`:205-231`). On classifier error: **fail open** — forward to worker, audit `classifier_failed`.
7. **Low confidence / other** (`:233-250`). `confidence < classifier_confidence_threshold` or `intent === 'other'` ⇒ `forwardToWorker(..., 'low_confidence' | 'other_intent')`.
8. **Cancel** (`:252-287`). Idempotent: an already-`cancelled` row is recorded (`already_cancelled`) and skipped. Otherwise `applyCancel`.
9. **Confirm / update_count** (`:289-349`). Idempotency guard at `:296-314` (already confirmed **and** count unchanged ⇒ log only). Otherwise `applyConfirm`. Then a question check (`:327-329`, `?` or a Hebrew question-word regex) forwards the message to the worker group as well so a mixed "confirm + question" isn't dropped.

### The shared side-effect core — `bookingResponse.ts`

This exists so a reaction-confirm and a text-confirm produce *identical* effects
(`bookingResponse.ts:13-22` documents the intent). If you change confirm/cancel
behaviour, change it **here**, not in a handler.

| Function | Line | Does |
|---|---|---|
| `applyConfirm` | `:108` | Push count change to Wix `updateNumberOfParticipants` (only when changed, `:119-150`) → `reminders.setStatus('confirmed', {participantCount, lastReplyTs})` → send `buildConfirmationAck({isUpdate: wasAlreadyConfirmed})` → `notifyClientResponse` → log `booking_confirmed` / `booking_count_updated`. Returns `{countChanged, wasAlreadyConfirmed, wixUpdateNote}`. |
| `applyCancel` | `:203` | Wix `cancelBooking` (with a reason string that records the channel, `:208-209`) → `setStatus('cancelled')` → `buildCancelAck` DM → `buildCancelNotice` to the worker group → `notifyClientResponse` → log `booking_cancelled`. |
| `notifyClientResponse` | `:49` | Best-effort manager DM (`reminders.client_response_notify_phone`). No-op when the phone is unset (`:59`). Failures are logged, never propagated. |
| `safeSendDirect` | `:265` | Swallows+logs ack send failures. |

`BookingResponseDeps` (`:27-41`) carries the `config: () => ({templates, tours})`
live getter, so both handlers' deps objects are passed straight through.

### Reaction flow — `reactionHandler.ts`

Entry point `handleReaction` (`reactionHandler.ts:260-285`) routing:

- Empty `reaction` (a *removal*) ⇒ ignore (`:263`) — there is no "un-confirm".
- `fromMe` ⇒ ignore (`:265`).
- In-memory dedup on `targetMessageId|senderId|reaction`, cap 1000 (`:40-49`, `:267`) — reactions arrive via `reactionTableMode.bulkUpsert` and can be re-emitted on resync.
- `chatId === workerGroupId` ⇒ `handleWorkerReaction` (`:209`): 👍 on a tracked `worker_forwards` row sends `forward.suggestedReply` to the customer, `markSent`, and posts `✅ התשובה המוצעת נשלחה ללקוח` back to the group.
- Empty `chatId` (the payload's nested key objects aren't always populated) ⇒ try the `worker_forwards` lookup first, then fall through to the customer path via `senderId`. Safe because `worker_forwards` is keyed by a group message id we recorded ourselves, so a miss just means "not a draft".
- Any other `@g.us` ⇒ ignore (`:276`) — public tour-group reactions are not booking answers.
- 1:1 (`@c.us`/`@lid`) and `targetFromMe !== false` ⇒ `handleCustomerReaction` (`:55`).

`handleCustomerReaction`: resolve phone (digits from `@c.us`, else
`resolveParticipantPhone`) → `findActiveForReply` → `classifyReactionEmoji`.

- No active reminder ⇒ log `reaction_no_active_reminder` and stop; deliberately **no** unmanaged-number reply (`:80-82`).
- Unrecognised emoji ⇒ audit `reaction_unrecognized` + a Hebrew "check manually" post to the worker group (`:95-127`).
- `cancel` ⇒ `applyCancel(via:'reaction')`; already-cancelled is a recorded no-op.
- `confirm` ⇒ already-`confirmed` is a **no-op** (`:165-183`), because a reaction carries no number so there is nothing to update and re-acking would just repeat itself. Otherwise `applyConfirm` with `newCount = reminder.participantCount`.

`reactionIntent.ts` is an explicit allowlist, not a model call. Key rules from its
header comment (`:11-18`): allowlist-only (unknown ⇒ `null` ⇒ escalate),
prefix-match the base codepoint so skin tones and FE0F match, and **cancel is
checked before confirm** (`:113`) because a wrongly-cancelled booking produces a
correctable staff notification whereas a wrongly-confirmed one silently becomes a
no-show. 🙏 is deliberately *excluded* from confirm (`:26-29`).

### Reminder runner — `runner.ts`

- `tickInFlight` re-entrancy guard (`runner.ts:75`, checked `:197`) — added after clients received the same reminder 6×.
- `sendOne` (`:77`): skips rows whose `welcomeDelivered === false` (`:90`, status `skipped_undelivered_welcome`); adds a deposit line from `wix.getOrderPaymentInfo` when there's an `orderIdEcom` (`:107`); when `isNewClientMessagingEnabled() === false` (`:128`) the reminder is redirected to the guide instead of the client; sends and fire-and-forgets `notifyDelivery.confirmAndAnnounce`.
- `tick` (`:196-218`): `reminders.due(now)`, then a **randomized inter-message delay** between `inter_message_delay_min_ms`/`max_ms` between consecutive sends (`:203-209`).
- `runNoReplyCheck` (`:220`): T-`no_reply_alert_minutes_before` digest of non-responders to the worker group.

### Booking intake — `webhook/bookingHandler.ts`

`handleBookingWebhook` (`:52`), outcome union at `:13-21`
(`sent|duplicate|invalid|skipped_allowlist|skipped_paused|forwarded_to_guide|deferred|failed`).

- Dedup claims **two** keys (`:70` and `:84-86`) — `bookingId` and `orderIdEcom` — because Wix fires both a flat automation webhook and a nested REST webhook with different identifiers.
- `computeReminderSendAtMs` (`:117`) then `combined = reminders.enabled && now >= sendAtMs` (`:125`): a booking made inside the reminder window gets one merged welcome+confirmation message (`booking_confirmation_lt24h`).
- Kill-switch branch (`:136-197`): when `new_client_messages_enabled === false`, the welcome is forwarded to the guide **and a reminders row is still upserted** with `welcomeDelivered: null`, so the backfill/runner logic stays consistent.

---

## 4. WhatsApp adapter — `app/src/whatsapp/`

`types.ts` is the contract; `client.ts` is the only file that touches
whatsapp-web.js or Puppeteer. Everything else depends on the interface, which is
what makes the stores/handlers testable with plain object stubs.

### Registered events (`client.ts`)

| Event | Line | Handling |
|---|---|---|
| `qr` | `:139` | `onQrRaw` callback + state. |
| `ready` | `:147` | Marks connected. |
| `disconnected` | `:204` | → `scheduleReconnect` (`:176`), backoff 30s/2m/5m, max 10 attempts, gives up if a QR is pending. |
| `auth_failure` | `:209` | Does **not** reconnect. |
| `message` | `:382` | → `handleMessageEvent` |
| `message_create` | `:387` | → `handleMessageEvent` (same path; a 500-entry `seenMessageIds` set at `:216` dedups the two) |
| `group_join` | `:393` | → `GroupJoinEvent` |
| `message_reaction` | `:417-466` | → `ReactionEvent` |

`handleMessageEvent` (`:217`): drops `fromMe`, splits on `@g.us` (group hooks +
`GroupMessage` dispatch) vs 1:1. The DM branch (`:270-380`) accepts both `@c.us`
and `@lid`, drops `SYSTEM_TYPES` (`:280`), and deliberately **keeps** empty-body
media messages so voice notes/images reach the reply handler.

**@lid → E.164 resolution** (`:296-357`): `@c.us` gives digits directly. For
`@lid` it tries, in order, `contact.id._serialized`, `_data.senderObj/sender.id`,
`msg.author`, `_data.author`, `_data.from`, `contact.id.user`. Any candidate
ending in `@lid` is rejected (`:330`), and `contact.number` is explicitly *not*
trusted because for LID contacts it returns the LID itself (`:341`).

The reaction event builder (`:417-466`) reads **both** `id._serialized` and
`id.$1` spellings (`serializedOf`, `:424-427`) because the raw reaction payload's
nested key objects aren't Base structures and so aren't covered by the forked
`_normalizeId()` shim. It derives `targetMessageId`, `chatId`, `senderId`,
`fromMe`, `targetFromMe` (left `undefined` when the key lacks the flag) and drops
events with no emoji or no target.

### Send path — the anti-spam design

- **One global serial queue.** `enqueueSendDirect` (`client.ts:585-593`); `sendDirect` (`:594`), `sendToGroup` (`:513`), polls (`:757`/`:774`), `forwardMessage` (`:915`), stickers (`:923`, `:1081`) all chain through it. The comment at `:507-512` ties this to the 2026-07-07 / 2026-07-20 incidents: **every** outbound message, group or DM, goes out strictly one at a time.
- **Humanized DM.** `sendDirectHumanized` (`:671`): `resolveNumberId` → `forceSyncLid` (`:629`, forces a USync via `WAWebContactSyncUtils`) → presence available → `sendSeen` → typing keep-alive every 2.5s for `typingMsForBody` (`:659`, 4s–30s scaled by length, ±15% jitter) → `chat.sendMessage`. Retries once on "No LID for user", then falls back to plain `client.sendMessage`.
- **Delivery confirmation.** `confirmDelivery` (`:733`) polls the ack until `>= 2` or `-1`, default 20s. `lastOutboundAcks` (`:890`) is the read-only view used by admin debug endpoints.
- **Link previews.** `fetchLinkPreview` (`:39`) fetches OG tags **in Node** and `sendToGroupImpl` (`:517`) injects them through `pupPage`, because in-page preview generation is unreliable on Railway.
- `clearChromiumSingletonLocks` (`:75`) removes stale Chromium `Singleton*` locks before launch.

`WhatsAppClient` interface: `types.ts:81-135`. Payload types: `IncomingDm`
(`:22-31`, note optional `type`/`hasMedia`), `ReactionEvent` (`:35-53`),
`GroupMessage` (`:57-68`), `GroupJoinEvent` (`:72`).

---

## 5. Persistence — `app/src/persistence/`

**The entire schema lives in `db.ts`** as an idempotent `MIGRATIONS` string array
(`db.ts:5-206`), applied in a transaction by `openDatabase` (`:213-235`). WAL is
enabled at `:217`. Only `/duplicate column/i` errors are swallowed (`:225`) so an
`ALTER TABLE ... ADD COLUMN` can be re-run; anything else throws. `SEEDS`
(`:208-211`) insert `automations_paused=false` and
`last_connect_state=disconnected`.

| Table | `db.ts` | Store | Purpose |
|---|---|---|---|
| `events` | `:6` | `eventLog.ts` `EventLog` | Structured event log mirror of the logger; `append/recent/since/pruneOlderThan`. |
| `job_runs` | `:17` | `jobHistory.ts` `JobHistory` | Job start/finish/outcome; `markStaleRunning` recovers rows orphaned by a crash. |
| `processed_webhooks` | `:31` | `webhookDedup.ts` `WebhookDedup` | `tryClaim/complete` — at-most-once webhook handling. |
| `pending_dms` | `:37` | `pendingDms.ts` `PendingDms` | Held/failed DMs; `enqueue/pending/markSent/recordFailure/markAbandoned`. |
| `control_state` | `:48` | `controlState.ts` `ControlState` (kv) | Backing store for `control/state.ts`. |
| `reminders` | `:53` (+ `ALTER` `:100` `order_id_ecom`, `:152` `welcome_delivered`) | `reminders.ts` `RemindersStore` | One row per booking; the pipeline's state machine. |
| `reply_audit` | `:71` | `reminders.ts` `ReplyAuditStore` | Every inbound customer message/reaction and what we decided. |
| `worker_forwards` | `:85` | `workerForwards.ts` `WorkerForwardsStore` | Worker-group forwards keyed by the **group message id**, so a 👍 reaction can find the draft. |
| `group_members` | `:105` | `groupMembers.ts` `GroupMembersStore` | First-seen stamps; feeds the "new joiner" spam signal. |
| `spam_actions` | `:114` | `groupMembers.ts` `SpamActionsStore` | Moderation verdicts + enforcement results (incl. resolved phone, so a wrongly-kicked customer can be re-added). |
| `guide_notifications` | `:134` | `guideNotifications.ts` | Per-occurrence dedup for guide roster/day-before/poll sends. |
| `private_tour_events` | `:158` | `privateTourEvents.ts` | Calendar-sourced private tours + LLM-parsed fields; `computeContentHash` drives re-parse. |
| `private_tour_notifications` | `:179` | `privateTourNotifications.ts` | Dedup for private-tour day-before notifications. |
| `guide_photo_forwards` | `:198` | *(no dedicated store class)* | Written from the guide-photo paths; verify before relying on it. |

`reminders.ts` specifics worth knowing:

- `ReminderStatus` (`:3-9`): `awaiting_send | awaiting_reply | confirmed | cancelled | no_reply | skipped_undelivered_welcome`.
- `findActiveForReply(phone, nowIso)` (`:131-162`): any **future-start** row for that phone, ranked `awaiting_reply < awaiting_send < confirmed < cancelled`, then `created_at DESC`. This is the single "which booking is this person talking about?" resolver, used by both the reply and reaction handlers.
- `due(nowIso)` (`:164`): `status='awaiting_send' AND sent_at_iso IS NULL AND send_at_iso <= now`.
- Others: `upsert` `:72`, `get` `:113`, `markSent` `:177`, `setWelcomeDelivered` `:188`, `hasConfirmedDelivery` `:204` (gates the new-contact hold), `setStatus` `:211`, `pendingNoReply` `:236`, `forDate` `:249`.

`control/state.ts` — `ControlStateService`: `isPaused()` (`:9`),
`isNewContactRestricted()` (`:31-34`) which **defaults to `true` (restricted)
when the key is unset** (`:33`), cleared only via the admin API.

---

## 6. Jobs & scheduling

### `app/src/jobs/runner.ts`

`runJob({jobName, dryRun, history, logger, fn})` (`:15`). A module-level
`runningJobs: Set<JobName>` (`:13`) makes a second concurrent invocation return
`status:'skipped'` rather than double-run. Wraps `history.start`/`finish` and
emits `<job>_start` / `<job>_end` / `<job>_error` events.

### Batch jobs

| File | Entry | Notes |
|---|---|---|
| `nightlyJob.ts` | `runNightlyJob` `:53` | Tomorrow's tours. Skips `language==='en'` tours and zero-booking pre-noon tours. Sends guide photos → broadcast (with a pre-fetched link preview) → sticker → closes groups (`setGroupMessagesAdminsOnly(true)`) → worker nightly summary. The broadcast is intentionally **not** gated on admin status; only *closing* is. `resolveTargets` (`:45`) redirects everything to the single test group in test mode. |
| `morningJob.ts` | `runMorningJob` `:43` | Opens groups **first** (`:78-93`), and skips the broadcast entirely when no tours are eligible (`:107-121`). |
| `privateTourSyncJob.ts` | `runPrivateTourSyncJob` `:31` | Fetch calendar window → `looksLikePrivateTour` filter → paced Gemini parses → `privateTourEvents.upsert`; supports a dry-run preview. |

### Poller runners

All four share the same shape: `start()/stop()/tick()`, a `tickInFlight`
re-entrancy guard, `isPaused()`, and `isConnected` = `isConnectedAndStable`.

| Runner | Entry | Notes |
|---|---|---|
| `reminders/runner.ts` | `createReminderRunner` `:67` | See §3. |
| `jobs/guideNotifyRunner.ts` | `createGuideNotifyRunner` `:69` | Pre-tour roster + optional `day_before` reminder + optional checklist poll. `tickInFlight` at `:79`/`:116` (added after a 2026-07-22 duplicate). Guides are **explicitly exempt** from the new-contact restriction (`:342`). |
| `jobs/reminderBackfillRunner.ts` | `createReminderBackfillRunner` `:64` | `tick()` = tight today+tomorrow sweep; `runWideSweep()` = `wide_sweep_days_ahead` (default 60), run **once at boot**, not on a timer. Deduped against `reminders.get(bookingId)`. |
| `jobs/privateTourNotifyRunner.ts` | `createPrivateTourNotifyRunner` `:83` | **Hard rule at `:40-45`: must NEVER send to `event.phone`.** Guide/manager only, permanently. |

`jobs/guidePhotosCollector.ts` (`createGuidePhotosCollector` `:43`) downloads
media **at receive time** with two strategies, because `getMessageById` /
`fetchMessages` / `forward` are unreliable on LID-migrated sessions. Currently
wired to `null` in `index.ts`.

### `app/src/scheduler.ts`

`startScheduler(app)` (`:18`) returns the `ScheduledTasks` handle (`:6-16`).

| Cron | Line | Job |
|---|---|---|
| `settings.schedule.nightly_cron` | `:68` | nightly broadcast (`nightlyFn` `:53`) |
| `settings.schedule.nightly_friday_cron` (optional) | `:76-77` | same fn, Friday-specific time |
| `settings.schedule.morning_cron` | `:80` | morning broadcast |
| `0 3 * * *` | `:96-97` | prune `events` older than 90 days |
| `*/15 * * * *` | `:158` | `runHealthCheckTick` (`:115`) |
| `private_tours.sync.cron` | `:164-179` | private-tour sync |

`runHealthCheckTick` calls `sessionMonitor.tick()` on **every** tick regardless
of connection state (`:128-136`); the comment there records a 2026-07-19 bug
where gating it behind "disconnected" left the alert flag stuck at `'1'` forever.

`forwardTodayGuidePhotos` (`:25`) reads the last 50 messages of a **hardcoded**
guides group id `'34651886491-1578239130@g.us'` (`:24`) — this is the one config
value that lives in code rather than YAML.

---

## 7. Messaging helpers — `app/src/messaging/`

| File | Key symbols | Purpose |
|---|---|---|
| `directMessage.ts` | `DirectMessageSender` `:44`, `send` `:51`, `drainPending` `:94` | Send gate, in order: paused → allowlist → **new-contact hold** (`:64`; a phone with no `hasConfirmedDelivery` is queued in `pending_dms` instead of sent) → disconnected hold → retry-wrapped `sendDirect`. `drainPending` makes one attempt per item with an 8s gap and abandons after 5 attempts. |
| `deliveryNotifier.ts` | `createDeliveryNotifier` `:47` | `confirmWithFollowUp` (`:62-67`) re-checks the ack ~45s later so a transient ack 0/1 doesn't fire a false "NOT DELIVERED" alert. `ping` `:69`, `failurePing` `:81`, `alertGuide` `:99` (sends two DMs — an alert then a copy-pasteable body), `sendAndAnnounce` `:117`, `confirmAndAnnounce` `:190`. |
| `builder.ts` | `buildBroadcastMessage` `:30`, `buildBookingConfirmation` `:78`, `buildWorkerNightlySummary` `:123` | Broadcast + welcome-DM composition. |
| `guideRosterMessage.ts` | `buildGuideRosterMessage` `:17`, `buildGuideDayBeforeReminder` `:68`, `buildChecklistPoll` `:119` | Guide-facing messages. |
| `privateTourMessage.ts` | `detectMissingInfo` `:19`, `buildPrivateTourReminder` `:59` | Private-tour guide/manager reminder; the missing-info block is appended only to the manager's copy. |
| `guideDirectory.ts` | `resolveGuidePhone` `:4`, `parseGuideNames` `:16` (splits `"ליאנה/עדי"`), `resolveGuidePhones` `:25` | `guides.yaml` name → phone lookups. |
| `guideForward.ts` | `sendGuideForward` `:14` | Sends a header then the body as separate messages so the forwarded text stays clean. |
| `meetingPointResolver.ts` | `PRIVATE_TOUR_KEYWORD_TABLE` `:18`, `resolveMeetingPointFromTourName` `:59` | Longest-keyword-first matching with consumption; ambiguity judged on *distinct* tour ids. |
| `allowlistGate.ts` | `allowlistAllows` `:3` | `explicit` / `rule` (country codes) / `open`. |
| `broadcaster.ts` | `Broadcaster` `:14` | Group fan-out with per-group results. |
| `retry.ts` | `retry` `:7` | Attempts + backoff array. |
| `phoneNormalizer.ts` | `normalizePhone` `:5` | Returns `null` for unparseable input — callers fall back to the raw value. |

---

## 8. Config — `app/src/config/`

Six YAML files in `app/config/`: `settings.yaml`, `tours.yaml`, `templates.yaml`
(18 keys), `groups.yaml`, `allowlist.yaml`, `guides.yaml`.

`loader.ts`:
- `AppConfig` (`:20-27`) — one field per file.
- `readYaml` (`:29`) wraps zod failures as `Invalid config at <path>: ...`.
- **Overlay precedence** — `resolve()` (`:50-56`): if `overlayDir/<name>.yaml` exists it is used **instead of** the bundled file. In production `overlayDir` is `<DATA_DIR>/config` on the Railway volume (`index.ts:64`). See CLAUDE.md for the push+reload procedure.
- `guides.yaml` is optional (`:60-63`), falling back to `{ guides: [] }` — which is why the test fixtures ship only five files.

`schemas.ts` — primitives at `:3-5` (`GroupIdSchema` must end `@g.us`,
`PhoneSchema` `/^\+\d{6,20}$/`, `CronSchema`). Schemas: Groups `:7`, Guides `:18`,
Tours `:34`, Templates `:52`, Allowlist `:101`, Settings `:110` with sub-blocks
`reminders` `:127`, `notifications` `:175`, `guide_notify` `:186`, `moderation`
`:229`, `private_tours` `:252`.

> ### 🔴 The stale-overlay rule
> **Any new field you add to a config schema must be `.optional()` or
> `.default()`.**
> Production reads config from the volume overlay, which is *not* redeployed with
> your code. A new **required** field means the stale overlay YAML fails zod
> validation, `loadConfig` throws in `main()`, and the process crash-loops on
> boot.
> Existing examples that document this in-line:
> `schemas.ts:64-70` (`unmanaged_number_reply`), `:74-82`
> (`client_response_notice`), `:83-91` (`private_tour_guide_reminder`), `:92-97`
> (`private_tour_missing_info_block`), `:146-150`
> (`client_response_notify_phone`), `:151-156` (inter-message delays),
> `:157-173` (`reminders.backfill`).

---

## 9. Moderation — `app/src/moderation/`

- `detector.ts` `createDetector` (`:49`) is a **hybrid**: `heuristicScore` (`:53`, keyword hits, links, new-joiner boost) decides the clear cases; only the middle band `[reviewMin, spamThreshold)` escalates to Gemini `llmVerdict` (`:101`). With no `GEMINI_API_KEY` the middle band resolves to ham — fail-open.
- `moderator.ts` `createModerator` (`:30`). `adminIds` (`:37`) caches group admins for 60s. `onGroupMessage` (`:63`) computes sender age against the **existing** `group_members` row *before* stamping first-seen (`:70-74`) so a 5-minute-old member reads as 5m, not 0; a `null` age means "not new" (safe default). Clean ham returns early without writing a row (`:78`). The sender's phone is resolved up front even when not enforcing (`:83`), specifically so a wrongly-kicked customer can be re-added.
- Enforcement (delete + kick) requires `verdict==='spam'` **and** the group to be in `enforce_in_groups` **and** the sender not to be an admin or in `never_action_phones` (`:86-91`). Detection and logging run everywhere.

---

## 10. HTTP surface — `app/src/http/`

`server.ts` `createHttpServer` (`:11`): `express.json({limit:'1mb'})` +
`cookieParser`, then `/healthz` (`:16-23`, returns `{wa, paused, uptime_s}` and
requires no auth), then webhook routes, then admin routes.

`auth.ts`: bcrypt `login` (`:41`) against `ADMIN_PASSWORD_HASH`, HMAC-signed
`wabot_admin` cookie (7-day max age), `requireAuth` (`:48`). Applied as
`exp.use('/admin/api', auth.requireAuth)` at `adminRoutes.ts:46` — so everything
under `/admin/api` is protected, and `/admin`, `/admin/login`, `/healthz`,
`/webhook/*` are not.

`webhookRoutes.ts` — `POST /webhook/wix` (`:7`): logs the raw payload, calls
`handleBookingWebhook`, and **always answers 200** with `{received:true, outcome}`
(`:33`) so Wix stops retrying; 500 only if the handler itself throws (`:41`).

`adminRoutes.ts` (1087 lines) — the notable endpoints:

| Endpoint | Line |
|---|---|
| `GET /admin`, `/admin/admin.js`, `/admin/admin.css` | `:20-24` |
| `POST /admin/login`, `/admin/logout` | `:26`, `:41` |
| `GET /admin/api/status` | `:48` |
| `GET .../events`, `.../jobs/recent`, `.../moderation/actions` | `:64`, `:71`, `:77` |
| `POST .../connect`, `.../disconnect` | `:82`, `:87` |
| `POST .../pause`, `.../resume` | `:92`, `:96` |
| `POST .../new-contact-restriction` | `:105` |
| `POST .../jobs/nightly`, `.../jobs/morning` (both accept `{"dry_run":true}`) | `:115`, `:131` |
| `POST .../jobs/private-tour-sync`, `.../private-tours/notify-now`, `GET .../private-tours` | `:146`, `:155`, `:185` |
| `POST .../reminders/backfill-now`, `.../backfill-wide-sweep-now` | `:164`, `:176` |
| `POST .../groups/close-all`, `.../groups/open-all` | `:202`, `:203` |
| `POST .../reminders/fire-now` | `:207` |
| `POST .../reminders/simulate-reply` (injects a synthetic DM into `app.replyHandler`) | `:231` |
| `GET .../reminders/classify`, `POST .../reminders/run-noreply-check`, `GET .../reminders` | `:265`, `:284`, `:290` |
| **`POST .../config/reload`** (the overlay hot-reload hook) | `:297` |
| `GET .../chats/list` | `:306` |
| `POST .../send-tomorrow-broadcast`, `.../send`, `.../send-confirmed` | `:315`, `:516`, `:963` |
| `POST .../tours/sync-from-wix`, `.../tours/patch` | `:452`, `:565` |
| guide-photos / images / stickers | `:612-783`, `:783-811`, `:848-1014` |
| `GET .../debug/link-preview`, `.../debug/session-monitor-state`, `POST .../debug/session-monitor-reset` | `:980`, `:998`, `:1004` |

---

## 11. Tests — `app/tests/`

- Runner: **vitest**. `app/vitest.config.ts` — `include: ['tests/**/*.test.ts']`, `environment: 'node'`, `testTimeout: 10000`. Run with `npm test` (= `vitest run`) from `app/`.
- 26 files in `tests/unit`, 11 in `tests/integration`. Fixtures in `tests/fixtures/config-valid/` (5 files, no `guides.yaml`) and `config-invalid/`.

**Unit convention** (see `tests/unit/replyHandlerNonText.test.ts`): a local
`makeDeps(overrides)` factory returns a plain object of `vi.fn()`s — `wa`
(`sendToGroup`/`sendDirect`/`forwardMessage`), `reminders.findActiveForReply`,
`audit.record`, `workerForwards.insert`, `classifier.classify`, `drafter: null`,
`logger: {info,warn,error}`. Settings are inlined with `debounceSeconds: 0` to
bypass the debounce, config is passed as the `config: () => ({templates, tours})`
getter, and the whole deps object is typed `any` (DMs cast `as any`). Pure
functions get plain input/output tests — `tests/unit/reactionIntent.test.ts` is
the cleanest example.

**Integration convention** (see `tests/integration/reminderRunner.test.ts`,
`db.test.ts`): a **real** `openDatabase(tmpDbPath())` under `os.tmpdir()` with an
`afterEach` unlink list (`:11-20`), `Partial<WhatsAppClient>` /
`Partial<WixClient>` cast to the full type, and a shared `noopLogger`
(`:22-27`). No mocking library for the DB — exercise the real SQLite.

Per CLAUDE.md: run `npm run typecheck && npm test` before any deploy.

---

## 12. Conventions (follow these)

1. **Config is a live getter, never a snapshot.** Anything long-lived takes
   `config: () => ({...})`, not a `config` value. Capturing config by value at
   construction time is a real bug this repo has already shipped and fixed —
   `reloadConfig` (`index.ts:343-351`) reassigns the closed-over `config`
   binding, so only getters see the new value. Live getters appear in
   `reminderRunner` (`index.ts:170`), `guideNotifyRunner` (`:213`),
   `privateTourNotifyRunner` (`:289`), `replyHandler` (`:408`),
   `reactionHandler` (`:429`), `dmSender` (`:141-148`), and `notifyDelivery`'s
   `alertPhone` (`:159`).
2. **New config fields are `.optional()` or `.default()`.** See §8.
3. **Hebrew copy lives in `config/templates.yaml`,** never inline in code, with
   `{snake_case}` placeholders substituted by `interpolate()`
   (`reminders/templates.ts:4-6`, `template.replace(/\{(\w+)\}/g, ...)` — an
   unknown key renders as an empty string, which is how optional lines like
   `{deposit_line}` and `{maps_url_line}` disappear). Add a builder function in
   `templates.ts` rather than interpolating at the call site. *(Exception:
   a few ad-hoc staff-facing worker-group notices are built inline — e.g.
   `reactionHandler.ts:109-113`, `replyHandler.ts:399-404`.)*
4. **Log through `logger`,** with `{source, eventType, message, metadata}`
   (`log/logger.ts:6-17`). Both sinks are written at once: a winston
   DailyRotateFile and the `events` table via `eventLog.append`
   (`logger.ts:47-62`), which is what the admin `/events` view reads. Use
   `snake_case` for `eventType`; `source` values in use include `startup`,
   `whatsapp`, `reply`, `jobs`, `pending`, `moderation`.
5. **Shared side effects go in one place.** `reminders/bookingResponse.ts` is the
   precedent: two channels (text, reaction), one implementation.
6. **Every poller gets a `tickInFlight` guard and gates on
   `isConnectedAndStable`.** Both exist because of dated production incidents;
   don't add a poller without them.
7. **All sends go through the client's queue.** Don't call
   `client.sendMessage` directly — use `sendToGroup` / `sendDirect` /
   `sendPoll*`, which are queued.
8. **Idempotency is explicit.** Confirm/cancel handlers check the current status
   before acting and record a `notes` string in `reply_audit` instead of
   silently returning.

---

## 13. Known gaps / things this map does not assert

- `wix/webhookVerifier.ts` `createSignatureVerifier` (`:151`) is still a stub — signature verification is not enforced (also noted in HANDOFF.md's backlog).
- The `guide_photo_forwards` table (`db.ts:198`) has no dedicated store class; its writers were not traced in detail.
- `notify/sessionMonitor.ts` (`createSessionMonitor` `:52`) and `notify/emailer.ts` (`createEmailer` `:32`, Resend HTTP API, no npm dep) were surveyed at interface level only; HANDOFF.md covers the alerting behaviour.
- `wix/client.ts` was surveyed by export (`createWixClient` `:88`; `getToursForDate` `:233`, `getConfirmedBookingsInRange` `:334`, `getGuideRostersForDate` `:371`, `cancelBooking` `:484`, `listServices` `:541`, `updateNumberOfParticipants` `:597`, `getOrderPaymentInfo` `:650`) rather than read line-by-line; the contract is `wix/types.ts:46-69`.
- The larger `adminRoutes.ts` handler bodies (broadcast preview, tour sync, sticker/image tooling) were mapped by route only.
