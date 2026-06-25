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
});
export type SettingsConfig = z.infer<typeof SettingsConfigSchema>;
