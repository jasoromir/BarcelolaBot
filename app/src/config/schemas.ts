import { z } from 'zod';

const GroupIdSchema = z.string().regex(/@g\.us$/, 'group id must end in @g.us');
const PhoneSchema = z.string().regex(/^\+\d{6,20}$/, 'phone must start with + and be digits');
const CronSchema = z.string().min(9);

export const GroupsConfigSchema = z.object({
  groups: z.array(
    z.object({
      id: GroupIdSchema,
      name: z.string().min(1),
      active: z.boolean(),
    }),
  ),
});
export type GroupsConfig = z.infer<typeof GroupsConfigSchema>;

export const GuidesConfigSchema = z.object({
  // Maps a guide's name (exactly as it appears as the Wix booking resource
  // name, e.g. "אדיר") to the WhatsApp number we send their pre-tour roster to.
  // Guides not listed here (or with no number yet) are simply skipped.
  guides: z.array(
    z.object({
      name: z.string().min(1),
      phone: PhoneSchema,
      // Defaults to active when omitted; the runner treats `active !== false`
      // as enabled, so leaving it out means "send to this guide".
      active: z.boolean().optional(),
    }),
  ),
});
export type GuidesConfig = z.infer<typeof GuidesConfigSchema>;

export const ToursConfigSchema = z.object({
  tours: z.record(
    z.string(),
    z.object({
      name_he: z.string().min(1),
      emoji: z.string().min(1),
      // description and meeting point may be blank for auto-seeded entries
      // whose Wix service doesn't yet have Hebrew copy. The builder treats
      // empty strings as "fall back to Wix data", so empty is safe.
      description_he: z.string(),
      meeting_point_he: z.string(),
      google_maps_url: z.string().url().optional(),
      language: z.enum(['he', 'en']).optional(),
    }),
  ),
});
export type ToursConfig = z.infer<typeof ToursConfigSchema>;

export const TemplatesConfigSchema = z.object({
  night_header: z.string().min(1),
  morning_header: z.string().min(1),
  footer: z.string().min(1),
  tour_block: z.string().min(1),
  booking_confirmation: z.string().min(1),
  booking_confirmation_lt24h: z.string().min(1),
  reminder_24h: z.string().min(1),
  confirmation_ack: z.string().min(1),
  confirmation_update_ack: z.string().min(1),
  cancel_ack: z.string().min(1),
  anti_reply_footer: z.string().min(1),
  // Optional with a default so an older overlay templates.yaml on the persistent
  // volume (which takes precedence over the bundled file) doesn't crash boot when
  // this field is added. Operators can override it in the overlay if desired.
  unmanaged_number_reply: z
    .string()
    .min(1)
    .default('מספר זה משמש להודעות אוטומטיות בלבד. נשמח אם תפנו את שאלותיכם ישירות לקבוצות הווטסאפ שלנו 🙏🌻'),
  no_reply_alert: z.string().min(1),
  worker_forward: z.string().min(1),
  cancel_notice: z.string().min(1),
  // Manager heads-up sent on every customer confirm/cancel. Optional with a
  // default so a stale overlay templates.yaml on the volume (which takes
  // precedence over the bundled file) doesn't crash boot when this is added.
  client_response_notice: z
    .string()
    .min(1)
    .default(
      '{status_emoji} *לקוח {status_text}*\n\n👤 *לקוח:* {client_name}\n📞 {phone}\n🎯 *סיור:* {tour_name_he}\n🕒 {date} בשעה {time}\n👥 {participant_count} משתתפים\n\n*אופן התגובה:* {via_text}\n_{raw_text}_\n',
    ),
  // Private (custom, non-catalog) tour day-before reminder, sent to the
  // assigned guide and the manager. Optional with a default so an older
  // overlay templates.yaml on the volume doesn't crash boot when this is added.
  private_tour_guide_reminder: z
    .string()
    .min(1)
    .default(
      'היי {guide_name} 👋\nתזכורת לסיור *פרטי* של מחר 🗓️\n\n🔒 *סיור פרטי* — לא מהקטלוג הכללי\n🚩 *{tour_name}*\n🕒 מחר בשעה *{time}*\n👤 *{client_name}* ({people_count} משתתפים)\n📞 {client_phone}\n{meeting_point_line}\n\n⏰ *חשוב להגיע לנקודת המפגש לפחות 15 דקות לפני תחילת הסיור.*\n\nסיור נעים! 🎉\n',
    ),
  // Appended only to the manager's copy when the parsed booking is missing
  // guide/phone/meeting-point info she should chase down.
  private_tour_missing_info_block: z
    .string()
    .min(1)
    .default('\n⚠️ *חסרים פרטים לבירור:*\n{missing_fields_list}\n'),
});
export type TemplatesConfig = z.infer<typeof TemplatesConfigSchema>;

export const AllowlistConfigSchema = z.object({
  mode: z.enum(['explicit', 'rule', 'open']),
  explicit_phones: z.array(PhoneSchema),
  rule: z.object({
    country_codes: z.array(z.string().regex(/^\+\d+$/)),
  }),
});
export type AllowlistConfig = z.infer<typeof AllowlistConfigSchema>;

export const SettingsConfigSchema = z.object({
  timezone: z.string().min(1),
  schedule: z.object({
    nightly_cron: CronSchema,
    nightly_friday_cron: CronSchema.optional(),
    morning_cron: CronSchema,
  }),
  broadcast: z.object({
    mode: z.enum(['test', 'production']),
    test_group_id: GroupIdSchema,
    inter_message_delay_ms: z.number().int().nonnegative(),
  }),
  min_bookings_to_run: z.number().int().nonnegative(),
  retry: z.object({
    max_attempts: z.number().int().positive(),
    backoff_ms: z.array(z.number().int().nonnegative()),
  }),
  reminders: z.object({
    enabled: z.boolean(),
    // Kill-switch for the welcome/confirmation DM and its 24h reminder to new
    // clients, independent of `enabled`. Flip to false to stop messaging
    // customers (e.g. while the WhatsApp account is flagged/recovering)
    // without touching guide rosters, group broadcasts, or moderation.
    new_client_messages_enabled: z.boolean().default(true),
    lead_time_hours: z.number().positive(),
    // Fixed clock time (HH:MM, 24h, local timezone) at which to send the
    // reminder on the day before the tour. Takes precedence over lead_time_hours.
    reminder_send_time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    combine_threshold_hours: z.number().positive(),
    no_reply_alert_minutes_before: z.number().int().positive(),
    poll_interval_seconds: z.number().int().positive(),
    official_contact_number: PhoneSchema,
    worker_group_id: GroupIdSchema,
    classifier_confidence_threshold: z.number().min(0).max(1),
    default_google_maps_url: z.string().url().optional(),
    reply_debounce_seconds: z.number().int().nonnegative(),
    // Manager who gets a DM every time a customer confirms or cancels a tour.
    // Optional — omit to disable the notification entirely (nothing else in the
    // confirm/cancel flow depends on it). Optional also keeps a stale overlay
    // settings.yaml on the volume from crashing boot.
    client_response_notify_phone: PhoneSchema.optional(),
    // Extra randomized pause between consecutive due reminders in the same
    // poll tick, on top of the per-message humanized typing delay — spreads
    // out a batch of several reminders so it doesn't read as bulk/automated
    // sending to WhatsApp's anti-spam detection. Defaults to a 10-20s gap.
    inter_message_delay_min_ms: z.number().int().nonnegative().default(10_000),
    inter_message_delay_max_ms: z.number().int().nonnegative().default(20_000),
    // Safety net: independently sweeps Wix for today's/tomorrow's confirmed
    // bookings and backfills a reminder row for any booking that was never
    // queued (e.g. booked while new_client_messages_enabled was off) —
    // dedup'd against RemindersStore so an already-queued/sent/replied
    // booking is never touched twice. Off by default; existing deployments
    // won't get the extra Wix API traffic unless explicitly enabled.
    backfill: z
      .object({
        enabled: z.boolean(),
        poll_interval_seconds: z.number().int().positive().default(900),
        // How many days ahead the wide, on-demand sweep looks (see
        // reminderBackfillRunner.runWideSweep) — run once at every
        // startup/deploy, not on a timer, to catch bookings made further out
        // than the tight today+tomorrow poll without recurring Wix API load.
        wide_sweep_days_ahead: z.number().int().positive().default(60),
      })
      .optional(),
  }),
  notifications: z
    .object({
      enabled: z.boolean(),
      email_to: z.string().email(),
      email_from: z.string().min(1).optional(),
      reactive_after_minutes: z.number().int().positive(),
      proactive_warn_after_days: z.number().positive(),
      // Chromium-wedge probe. Optional with defaults so a stale config overlay
      // can't crash boot (see the volume-overlay precedence note in CLAUDE.md).
      browser_probe_timeout_ms: z.number().int().positive().optional(),
      browser_probe_failures_before_alert: z.number().int().positive().optional(),
    })
    .optional(),
  // Pre-tour roster sent to the assigned guide a few minutes before the tour
  // starts. Off by default; enable once guide numbers are populated.
  guide_notify: z
    .object({
      enabled: z.boolean(),
      // How many minutes before tour start to send the guide their roster.
      minutes_before: z.number().int().positive(),
      // How often the poller checks for tours entering the send window.
      poll_interval_seconds: z.number().int().positive(),
      // When true, send to the test group instead of the guide's phone (debug).
      test_mode: z.boolean().optional(),
      test_group_id: GroupIdSchema.optional(),
      // Optional day-before reminder, sent only to specific guides (by Wix
      // resource name). Fires once per tour the evening before at send_time.
      // Separate from the pre-tour roster; contains only headcount-so-far.
      day_before: z
        .object({
          enabled: z.boolean(),
          // Local (timezone) clock time HH:MM to send the evening before.
          send_time: z.string().regex(/^\d{2}:\d{2}$/),
          // Guide names (exact Wix resource name) who get this reminder. Omit or
          // leave empty to send to ALL guides.
          guide_names: z.array(z.string().min(1)).optional(),
        })
        .optional(),
      // Optional native WhatsApp poll sent right after the pre-tour roster as a
      // checklist the guide ticks off. Items are free text (add more anytime).
      checklist_poll: z
        .object({
          enabled: z.boolean(),
          // Poll title/question line shown above the options.
          question: z.string().min(1),
          // Short note (sent as a text message before the poll) nudging the
          // guide to actually tick each item.
          note: z.string().min(1),
          // The checkable items, in display order. At least one required.
          items: z.array(z.string().min(1)).min(1),
          // Optional allowlist of guide names (exact Wix resource name). When
          // present, the poll is sent ONLY to these guides after their roster;
          // omit (or leave empty) to send it to every guide.
          guide_names: z.array(z.string().min(1)).optional(),
        })
        .optional(),
    })
    .optional(),
  moderation: z
    .object({
      enabled: z.boolean(),
      // Groups where the bot will actually delete + kick. Detection/logging runs
      // in every group; enforcement is gated to this list. Start with just the
      // test group, then add production groups once the bot is admin there.
      enforce_in_groups: z.array(GroupIdSchema),
      // A sender is "new" for this many minutes after first seen; new joiners
      // who post links/keywords are the strongest spam signal.
      new_joiner_window_minutes: z.number().int().positive(),
      // score >= spam_threshold → spam; [review_min, spam_threshold) → ask LLM;
      // below review_min → ham.
      score_spam_threshold: z.number().min(0).max(1),
      score_review_min: z.number().min(0).max(1),
      // Lowercased substrings that flag crypto/financial spam.
      keywords: z.array(z.string().min(1)),
      // Phones that must never be deleted/kicked (official contact, staff).
      never_action_phones: z.array(PhoneSchema),
    })
    .optional(),
  // Private (custom, non-catalog) tour bookings sourced from a Google
  // Calendar. Off by default; enable once the service account is set up and
  // the calendar has been shared with it.
  private_tours: z
    .object({
      enabled: z.boolean(),
      calendar_id: z.string().min(1).default('guidesbarcelola@gmail.com'),
      // Daily batch: fetch + LLM-parse new/changed private bookings.
      sync: z
        .object({
          enabled: z.boolean(),
          cron: CronSchema.default('0 18 * * *'),
          window_days_back: z.number().int().nonnegative().default(0),
          window_days_forward: z.number().int().positive().default(14),
        })
        .optional(),
      // Day-before notify: reminds the assigned guide + manager about
      // tomorrow's private tours.
      notify: z
        .object({
          enabled: z.boolean(),
          send_time: z.string().regex(/^\d{2}:\d{2}$/),
          poll_interval_seconds: z.number().int().positive(),
          // When true, send to test_group_id instead of real guide phones (debug).
          test_mode: z.boolean().optional(),
          test_group_id: GroupIdSchema.optional(),
          // Guide name (exact guides.yaml entry) always notified in addition to
          // the assigned guide — the manager who chases down missing info.
          manager_guide_name: z.string().min(1).default('ליאנה'),
        })
        .optional(),
    })
    .optional(),
});
export type SettingsConfig = z.infer<typeof SettingsConfigSchema>;
