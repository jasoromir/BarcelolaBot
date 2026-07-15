import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase } from '../../src/persistence/db.js';
import { PrivateTourEventsStore } from '../../src/persistence/privateTourEvents.js';
import { JobHistory } from '../../src/persistence/jobHistory.js';
import { runPrivateTourSyncJob } from '../../src/jobs/privateTourSyncJob.js';
import * as calendarEvents from '../../src/google/calendarEvents.js';
import * as parser from '../../src/reminders/privateEventParser.js';

const tmpFiles: string[] = [];
afterEach(() => {
  for (const f of tmpFiles) if (fs.existsSync(f)) fs.unlinkSync(f);
  tmpFiles.length = 0;
  vi.restoreAllMocks();
});
function tmpDbPath(): string {
  const p = path.join(os.tmpdir(), `wabot-pts-${Date.now()}-${Math.random()}.sqlite`);
  tmpFiles.push(p);
  return p;
}

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} } as any;

function makeGoogleEvent(overrides: Partial<any> = {}) {
  return {
    id: 'evt-1',
    summary: 'סיור גאודי פרטי. דנה. 5 אנשים. מדריך אדיר',
    description: 'דנה +972544211402',
    location: null,
    start: { dateTime: '2026-07-14T08:00:00.000Z' },
    end: { dateTime: '2026-07-14T11:00:00.000Z' },
    ...overrides,
  };
}

function makeParsedFields(overrides: Partial<any> = {}) {
  return {
    tourName: 'גאודי',
    guide: 'אדיר',
    clientName: 'דנה',
    peopleCount: '5',
    phone: '+972544211402',
    email: null,
    meetingPoint: null,
    ...overrides,
  };
}

describe('runPrivateTourSyncJob', () => {
  it('parses a new private event and caches it', async () => {
    vi.spyOn(calendarEvents, 'fetchCalendarEventsInRange').mockResolvedValue([makeGoogleEvent()]);
    const parseSpy = vi.spyOn(parser, 'llmParsePrivateEvent').mockResolvedValue(makeParsedFields());

    const db = openDatabase(tmpDbPath());
    const store = new PrivateTourEventsStore(db);
    const history = new JobHistory(db);

    const outcome = await runPrivateTourSyncJob({
      calendarId: 'guidesbarcelola@gmail.com',
      auth: {} as any,
      store,
      logger: noopLogger,
      history,
      geminiApiKey: 'fake-key',
      windowDaysBack: 2,
      windowDaysForward: 14,
      dryRun: false,
      callDelayMs: 0,
    });

    expect(outcome.status).toBe('success');
    expect(parseSpy).toHaveBeenCalledTimes(1);
    const cached = store.get('evt-1');
    expect(cached?.tourName).toBe('גאודי');
    expect(cached?.guide).toBe('אדיר');
    expect(cached?.phone).toBe('+972544211402');
  });

  it('skips the LLM call for an already-cached, unchanged event', async () => {
    vi.spyOn(calendarEvents, 'fetchCalendarEventsInRange').mockResolvedValue([makeGoogleEvent()]);
    const parseSpy = vi.spyOn(parser, 'llmParsePrivateEvent').mockResolvedValue(makeParsedFields());

    const db = openDatabase(tmpDbPath());
    const store = new PrivateTourEventsStore(db);
    const history = new JobHistory(db);

    const runOnce = () =>
      runPrivateTourSyncJob({
        calendarId: 'guidesbarcelola@gmail.com',
        auth: {} as any,
        store,
        logger: noopLogger,
        history,
        geminiApiKey: 'fake-key',
        windowDaysBack: 2,
        windowDaysForward: 14,
        dryRun: false,
        callDelayMs: 0,
      });

    await runOnce();
    expect(parseSpy).toHaveBeenCalledTimes(1);

    const outcome2 = await runOnce();
    expect(parseSpy).toHaveBeenCalledTimes(1); // still 1 — second run was a cache hit
    expect(outcome2.metadata?.skippedCached).toBe(1);
  });

  it('re-parses when the event content changes (content hash mismatch)', async () => {
    const parseSpy = vi.spyOn(parser, 'llmParsePrivateEvent').mockResolvedValue(makeParsedFields());
    const db = openDatabase(tmpDbPath());
    const store = new PrivateTourEventsStore(db);
    const history = new JobHistory(db);

    const runOnce = (event: any) => {
      vi.spyOn(calendarEvents, 'fetchCalendarEventsInRange').mockResolvedValue([event]);
      return runPrivateTourSyncJob({
        calendarId: 'guidesbarcelola@gmail.com',
        auth: {} as any,
        store,
        logger: noopLogger,
        history,
        geminiApiKey: 'fake-key',
        windowDaysBack: 2,
        windowDaysForward: 14,
        dryRun: false,
        callDelayMs: 0,
      });
    };

    await runOnce(makeGoogleEvent());
    expect(parseSpy).toHaveBeenCalledTimes(1);

    // Same event ID, but the summary text changed on Google's side.
    await runOnce(makeGoogleEvent({ summary: 'סיור גאודי פרטי. דנה. 6 אנשים. מדריך אדיר' }));
    expect(parseSpy).toHaveBeenCalledTimes(2);
  });

  it('continues past a single failed parse instead of aborting the batch', async () => {
    vi.spyOn(calendarEvents, 'fetchCalendarEventsInRange').mockResolvedValue([
      makeGoogleEvent({ id: 'evt-fail' }),
      makeGoogleEvent({ id: 'evt-ok' }),
    ]);
    vi.spyOn(parser, 'llmParsePrivateEvent').mockImplementation(async (_key, input: any) => {
      if (input.summary.includes('fail-marker')) throw new Error('gemini 429');
      return makeParsedFields();
    });
    // Force the first event to fail by tagging its summary (still matches the
    // private-tour detector — סיור/פרטי present — so it isn't filtered out
    // before ever reaching the parser), second succeeds.
    vi.spyOn(calendarEvents, 'fetchCalendarEventsInRange').mockResolvedValue([
      makeGoogleEvent({ id: 'evt-fail', summary: 'סיור פרטי fail-marker' }),
      makeGoogleEvent({ id: 'evt-ok' }),
    ]);

    const db = openDatabase(tmpDbPath());
    const store = new PrivateTourEventsStore(db);
    const history = new JobHistory(db);

    const outcome = await runPrivateTourSyncJob({
      calendarId: 'guidesbarcelola@gmail.com',
      auth: {} as any,
      store,
      logger: noopLogger,
      history,
      geminiApiKey: 'fake-key',
      windowDaysBack: 2,
      windowDaysForward: 14,
      dryRun: false,
      callDelayMs: 0,
    });

    expect(outcome.status).toBe('partial');
    expect(outcome.metadata?.failed).toBe(1);
    expect(outcome.metadata?.parsedNew).toBe(1);
    expect(store.get('evt-fail')).toBeUndefined();
    expect(store.get('evt-ok')).toBeDefined();
  });

  it('removes a cached event that is no longer purple/present (deleteStaleInRange)', async () => {
    const db = openDatabase(tmpDbPath());
    const store = new PrivateTourEventsStore(db);
    const history = new JobHistory(db);

    vi.spyOn(calendarEvents, 'fetchCalendarEventsInRange').mockResolvedValueOnce([
      makeGoogleEvent(),
    ]);
    vi.spyOn(parser, 'llmParsePrivateEvent').mockResolvedValue(makeParsedFields());
    await runPrivateTourSyncJob({
      calendarId: 'guidesbarcelola@gmail.com',
      auth: {} as any,
      store,
      logger: noopLogger,
      history,
      geminiApiKey: 'fake-key',
      windowDaysBack: 2,
      windowDaysForward: 14,
      dryRun: false,
      callDelayMs: 0,
    });
    expect(store.get('evt-1')).toBeDefined();

    // Second run: the event is gone from the calendar fetch (cancelled/recolored).
    vi.spyOn(calendarEvents, 'fetchCalendarEventsInRange').mockResolvedValueOnce([]);
    await runPrivateTourSyncJob({
      calendarId: 'guidesbarcelola@gmail.com',
      auth: {} as any,
      store,
      logger: noopLogger,
      history,
      geminiApiKey: 'fake-key',
      windowDaysBack: 2,
      windowDaysForward: 14,
      dryRun: false,
      callDelayMs: 0,
    });
    expect(store.get('evt-1')).toBeUndefined();
  });

  it('dry run writes nothing and never calls the LLM', async () => {
    vi.spyOn(calendarEvents, 'fetchCalendarEventsInRange').mockResolvedValue([makeGoogleEvent()]);
    const parseSpy = vi.spyOn(parser, 'llmParsePrivateEvent').mockResolvedValue(makeParsedFields());

    const db = openDatabase(tmpDbPath());
    const store = new PrivateTourEventsStore(db);
    const history = new JobHistory(db);

    const outcome = await runPrivateTourSyncJob({
      calendarId: 'guidesbarcelola@gmail.com',
      auth: {} as any,
      store,
      logger: noopLogger,
      history,
      geminiApiKey: 'fake-key',
      windowDaysBack: 2,
      windowDaysForward: 14,
      dryRun: true,
      callDelayMs: 0,
    });

    expect(parseSpy).not.toHaveBeenCalled();
    expect(store.get('evt-1')).toBeUndefined();
    expect(outcome.metadata?.parsedNew).toBe(1); // preview count, nothing persisted
  });
});
