// Domain types shared across modules. No I/O, no framework imports.

export type ISODateString = string; // e.g. "2026-04-25"
export type ISODateTime = string; // e.g. "2026-04-25T19:30:00.000Z"

export interface Tour {
  id: string; // must match a key in tours.yaml
  date: ISODateString;
  startTime: string; // "HH:mm" local (Europe/Madrid)
  endTime: string; // "HH:mm" local
  bookingCount: number;
}

export interface BookingEvent {
  bookingId: string;
  tourId: string;
  date: ISODateString;
  time: string; // "HH:mm"
  clientName: string;
  phone: string; // as received from Wix (not yet normalized)
}

export interface GroupRef {
  id: string; // WhatsApp group id (ends in @g.us)
  name: string; // human-readable
}

export type WhatsAppState =
  | { kind: 'disconnected' }
  | { kind: 'qr_pending'; qrDataUrl: string }
  | { kind: 'connected'; phone: string };

export type AutomationsState = 'running' | 'paused';

export type JobName = 'nightly' | 'morning';

export type JobStatus = 'running' | 'success' | 'partial' | 'failed' | 'skipped';

export interface JobOutcome {
  jobName: JobName;
  status: JobStatus;
  toursCount: number;
  groupsSent: number;
  groupsClosed: number;
  dryRun: boolean;
  error?: string;
  metadata?: Record<string, unknown>;
}
