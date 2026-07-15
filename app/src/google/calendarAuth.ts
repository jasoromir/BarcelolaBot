import { google } from 'googleapis';

const SCOPES = ['https://www.googleapis.com/auth/calendar.readonly'];

export type CalendarAuth = InstanceType<typeof google.auth.JWT>;

/**
 * Production calendar auth: a Google service account, granted read-only
 * access by sharing the target calendar with its email address. Unlike the
 * interactive OAuth flow in scripts/lib/google-calendar-auth.ts (dev-only,
 * requires a browser), this needs no user consent and never expires.
 */
export function createCalendarAuthFromServiceAccount(keyJson: string): CalendarAuth {
  const creds = JSON.parse(keyJson) as { client_email: string; private_key: string };
  return new google.auth.JWT({ email: creds.client_email, key: creds.private_key, scopes: SCOPES });
}
