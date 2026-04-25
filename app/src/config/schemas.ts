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
      description_he: z.string().min(1),
      meeting_point_he: z.string().min(1),
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
});
export type SettingsConfig = z.infer<typeof SettingsConfigSchema>;
