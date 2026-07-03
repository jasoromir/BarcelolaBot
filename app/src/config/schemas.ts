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
    .default('מספר זה אינו מנוהל, אנא שאלו את שאלתכם ישירות בקבוצות הווטסאפ שלנו 🌻'),
  no_reply_alert: z.string().min(1),
  worker_forward: z.string().min(1),
  cancel_notice: z.string().min(1),
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
  }),
  notifications: z
    .object({
      enabled: z.boolean(),
      email_to: z.string().email(),
      email_from: z.string().min(1).optional(),
      reactive_after_minutes: z.number().int().positive(),
      proactive_warn_after_days: z.number().positive(),
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
});
export type SettingsConfig = z.infer<typeof SettingsConfigSchema>;
