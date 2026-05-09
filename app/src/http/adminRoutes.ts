import type { Express, Request, Response } from 'express';
import path from 'node:path';
import type { App } from '../app.js';
import { createAuth } from './auth.js';
import { runNightlyJob } from '../jobs/nightlyJob.js';
import { runMorningJob } from '../jobs/morningJob.js';
import { GroupAdminService } from '../whatsapp/groupAdmin.js';

export interface AdminConfig {
  passwordHash: string;
  cookieSecret: string;
  webDir: string;
}

export function registerAdminRoutes(exp: Express, app: App, cfg: AdminConfig): void {
  const auth = createAuth(cfg);

  exp.get('/admin', (_req: Request, res: Response) => {
    res.sendFile(path.join(cfg.webDir, 'admin.html'));
  });
  exp.get('/admin/admin.js', (_req, res) => res.sendFile(path.join(cfg.webDir, 'admin.js')));
  exp.get('/admin/admin.css', (_req, res) => res.sendFile(path.join(cfg.webDir, 'admin.css')));

  exp.post('/admin/login', async (req, res) => {
    const password = (req.body?.password as string) ?? '';
    const cookie = await auth.login(password);
    if (!cookie) {
      res.status(401).json({ error: 'bad password' });
      return;
    }
    res.cookie(auth.COOKIE_NAME, cookie, {
      httpOnly: true,
      sameSite: 'strict',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 7 * 24 * 3600 * 1000,
    });
    res.json({ ok: true });
  });
  exp.post('/admin/logout', (_req, res) => {
    res.clearCookie(auth.COOKIE_NAME);
    res.json({ ok: true });
  });

  exp.use('/admin/api', auth.requireAuth);

  exp.get('/admin/api/status', (_req, res) => {
    const state = app.whatsapp.state();
    res.json({
      wa: state.kind,
      phone: state.kind === 'connected' ? state.phone : null,
      qrDataUrl: state.kind === 'qr_pending' ? state.qrDataUrl : null,
      paused: app.controlState.isPaused(),
      broadcastMode: app.config.settings.broadcast.mode,
      testGroupId: app.config.settings.broadcast.test_group_id,
      groupsCount: app.config.groups.groups.filter((g) => g.active).length,
      toursCount: Object.keys(app.config.tours.tours).length,
      allowlistMode: app.config.allowlist.mode,
    });
  });

  exp.get('/admin/api/events', (req, res) => {
    const since = Number((req.query.since as string) ?? 0);
    const limit = Math.min(Number((req.query.limit as string) ?? 100), 500);
    const rows = since > 0 ? app.eventLog.since(since, limit) : app.eventLog.recent(limit);
    res.json({ events: rows });
  });

  exp.get('/admin/api/jobs/recent', (_req, res) => {
    res.json({ runs: app.jobHistory.recent(20) });
  });

  exp.post('/admin/api/connect', async (_req, res) => {
    await app.whatsapp.start();
    res.json({ ok: true, state: app.whatsapp.state().kind });
  });

  exp.post('/admin/api/disconnect', async (_req, res) => {
    await app.whatsapp.stop();
    res.json({ ok: true, state: app.whatsapp.state().kind });
  });

  exp.post('/admin/api/pause', (_req, res) => {
    app.controlState.pause();
    res.json({ ok: true, paused: true });
  });
  exp.post('/admin/api/resume', (_req, res) => {
    app.controlState.resume();
    res.json({ ok: true, paused: false });
  });

  exp.post('/admin/api/jobs/nightly', async (req, res) => {
    const dryRun = Boolean(req.body?.dry_run);
    const result = await runNightlyJob({
      config: app.config,
      whatsapp: app.whatsapp,
      wix: app.wix,
      history: app.jobHistory,
      logger: app.logger,
      isPaused: () => app.controlState.isPaused(),
      dryRun,
    });
    res.json({ result });
  });

  exp.post('/admin/api/jobs/morning', async (req, res) => {
    const dryRun = Boolean(req.body?.dry_run);
    const result = await runMorningJob({
      config: app.config,
      whatsapp: app.whatsapp,
      wix: app.wix,
      history: app.jobHistory,
      logger: app.logger,
      isPaused: () => app.controlState.isPaused(),
      dryRun,
    });
    res.json({ result });
  });

  async function bulkGroupAction(action: 'close' | 'open', res: Response): Promise<void> {
    const targets =
      app.config.settings.broadcast.mode === 'test'
        ? [app.config.settings.broadcast.test_group_id]
        : app.config.groups.groups.filter((g) => g.active).map((g) => g.id);
    const svc = new GroupAdminService(app.whatsapp);
    const result = action === 'close' ? await svc.closeAll(targets) : await svc.openAll(targets);
    res.json(result);
  }
  exp.post('/admin/api/groups/close-all', async (_req, res) => bulkGroupAction('close', res));
  exp.post('/admin/api/groups/open-all', async (_req, res) => bulkGroupAction('open', res));

  // ---- Reminder test endpoints --------------------------------------------
  // Fire any reminder immediately regardless of its send_at time.
  exp.post('/admin/api/reminders/fire-now', async (req, res) => {
    const bookingId = (req.body?.booking_id as string) || (req.query.booking_id as string);
    if (!bookingId) {
      res.status(400).json({ error: 'booking_id required' });
      return;
    }
    const r = app.reminders.get(bookingId);
    if (!r) {
      res.status(404).json({ error: 'reminder not found' });
      return;
    }
    // Force send_at to now so the runner picks it up; then tick.
    app.reminders.upsert({
      ...r,
      status: 'awaiting_send',
      sendAtIso: new Date().toISOString(),
      sentAtIso: null,
    });
    const result = await app.reminderRunner.tick();
    res.json({ ok: true, result });
  });

  // Inject a fake inbound DM for testing the classify+handle path without
  // needing the customer to actually message the bot.
  exp.post('/admin/api/reminders/simulate-reply', async (req, res) => {
    const bookingId = req.body?.booking_id as string | undefined;
    const text = req.body?.text as string | undefined;
    if (!bookingId || !text) {
      res.status(400).json({ error: 'booking_id and text required' });
      return;
    }
    const r = app.reminders.get(bookingId);
    if (!r) {
      res.status(404).json({ error: 'reminder not found' });
      return;
    }
    // Use the real WhatsApp incoming-DM pipeline by invoking the handler
    // the same way a real message would. Because onIncomingDm is private to
    // the client, we call the reply handler through a direct simulate path:
    // easiest is to emit via the client, but we can re-invoke classifier + handler.
    // Simpler: the whatsapp client exposes onIncomingDm which allows handlers to
    // be appended; we can't reach the handlers from here. So we go through a
    // public stub: send ourselves a message on behalf of the phone by creating
    // a synthetic DM event via a dedicated simulate hook.
    const fakeDm = {
      messageId: `simulated-${Date.now()}`,
      fromPhoneE164: r.phone,
      body: text,
      timestamp: Math.floor(Date.now() / 1000),
    };
    if (!app.replyHandler) {
      res.status(500).json({ error: 'reply handler not attached (reminders disabled?)' });
      return;
    }
    await app.replyHandler(fakeDm);
    res.json({ ok: true });
  });

  exp.get('/admin/api/reminders/classify', async (req, res) => {
    const text = (req.query.text as string) ?? '';
    if (!text) {
      res.status(400).json({ error: 'text query param required' });
      return;
    }
    const currentCount = Number((req.query.current_count as string) ?? 1);
    if (!app.classifier) {
      res.status(500).json({ error: 'classifier not attached (reminders disabled?)' });
      return;
    }
    try {
      const result = await app.classifier.classify(text, { currentCount });
      res.json({ ok: true, result });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  exp.post('/admin/api/reminders/run-noreply-check', async (req, res) => {
    const minutesBefore = Number(req.body?.minutes_before ?? 120);
    const result = await app.reminderRunner.runNoReplyCheck(minutesBefore);
    res.json({ ok: true, result });
  });

  exp.get('/admin/api/reminders', (_req, res) => {
    const rows = app.db
      .prepare('SELECT * FROM reminders ORDER BY created_at DESC LIMIT 50')
      .all();
    res.json({ reminders: rows });
  });

  exp.post('/admin/api/config/reload', (_req, res) => {
    try {
      app.reloadConfig();
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ ok: false, error: (err as Error).message });
    }
  });

  exp.get('/admin/api/chats/list', async (_req, res) => {
    try {
      const chats = await app.whatsapp.listChats();
      res.json({ chats });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  exp.post('/admin/api/send-tomorrow-broadcast', async (req, res) => {
    try {
      const targetPhone = req.body.phone || '+34623964800';

      // Fetch tomorrow's tours from Wix
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const dateStr: string = tomorrow.toISOString().split('T')[0] as string;

      const tours = await app.wix.getToursForDate(dateStr);

      if (tours.length === 0) {
        res.json({ ok: true, message: 'No tours tomorrow', sent: false });
        return;
      }

      // Build Hebrew message
      const hebrewMessage = buildTomorrowMessage(tours, dateStr) as string;

      // Build guide info
      const guideInfo = buildGuideAssignments(tours) as string;

      // Send main message
      await app.whatsapp.sendDirect(targetPhone, hebrewMessage);

      // Wait 2s
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Send guide assignments
      await app.whatsapp.sendDirect(targetPhone, guideInfo);

      res.json({
        ok: true,
        tourCount: tours.length,
        totalParticipants: tours.reduce((sum, t) => sum + t.bookingCount, 0),
        messagePreview: hebrewMessage.substring(0, 100),
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  function buildTomorrowMessage(tours: any[], date: string): string {
    const weekdays = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
    const dateObj = new Date(date);
    const weekday = weekdays[dateObj.getDay()];
    const day = dateObj.getDate();
    const month = dateObj.getMonth() + 1;

    let msg = '*לילה טוב לכל המטיילים והמטיילות האהובים מ- Barcelola Tours ✨🌜*\n\n';
    msg += `❤️ *לנמצאים בברצלונה - הצטרפו לסיורי ברצלולה, מחר יום ${weekday} ה-${day}.${month}* ❤️\n\n`;
    msg += '*סיורים חינם על בסיס טיפ בתוך העיר*\n\n';

    for (const tour of tours) {
      const info = getTourDescription(tour.serviceId || '', tour.title || '');
      msg += `${info.emoji} ${tour.startTime || ''}-${tour.endTime || ''}\n`;
      msg += `*${info.nameHe}*\n`;
      msg += `${info.descriptionHe}\n`;
      msg += `*נקודת ושעת מפגש* - ${info.meetingPoint}\n\n`;
    }

    msg += '🌻 *למידע נוסף והרשמה לסיורים הכנסו לאתר שלנו:*\n';
    msg += 'https://www.barcelola-tours.com/barcelolatours\n\n';
    msg += '🌻בואו גם ל *קבוצת הפייסבוק* שלנו!\n';
    msg += 'https://www.facebook.com/groups/barcelolatours/?ref=share';

    return msg;
  }

  function buildGuideAssignments(tours: any[]): string {
    let msg = '*הדרכות למחר:*\n\n';

    for (const tour of tours) {
      const guideName = 'לא משובץ'; // Default - you can add guide assignment logic later
      msg += `🌻 *${tour.tourTitle || tour.title || 'סיור'}* (${tour.startTime || ''})\n`;
      msg += `מדריך/ה: ${guideName}\n`;
      msg += `מספר משתתפים: ${tour.bookingCount || 0}\n\n`;
    }

    return msg;
  }

  function getTourDescription(serviceId: string, title: string) {
    const tourDescriptions: Record<string, any> = {
      '4422ee5f-957b-45c8-bf06-876482fd2b57': {
        emoji: '🌻',
        nameHe: 'גותיראמבלה ללא הפסקה',
        descriptionHe: 'בסיור נלמד ונכיר את הקטלאני המפורסם מכולם - אנטוני גאודי. נראה את הבתים המפורסמים שלו, נבין מה הופך אותו לאדריכל כל כך ייחודי ונגלה סיפורים מרתקים על חייו.',
        meetingPoint: '10:15 בכניסה למסעדת הארד רוק קפה, פלאסה קטלוניה',
      },
      '83faaa08-7ce3-4cf5-8743-637f2b92371b': {
        emoji: '⚽',
        nameHe: 'בארסהלולה',
        descriptionHe: 'סיור מרתק לאצטדיון בארסה, נכיר את ההיסטוריה של המועדון המפורסם ונבקר במוזיאון הכי עשיר בטרופיים בעולם!',
        meetingPoint: '10:00 בכניסה למסעדת הארד רוק קפה, פלאסה קטלוניה',
      },
      'abccdd90-4eae-4b1b-8f37-401a69236973': {
        emoji: '✡️',
        nameHe: 'היהודים באים',
        descriptionHe: 'נלמד על ההיסטוריה היהודית המרתקת של ברצלונה, נבקר בשכונה היהודית העתיקה ונגלה סיפורים מרגשים על הקהילה היהודית.',
        meetingPoint: '15:00 ליד תיאטרון Apolo, צמוד לתחנת המטרו Paral·lel',
      },
    };

    return tourDescriptions[serviceId] || {
      emoji: '🌻',
      nameHe: title,
      descriptionHe: `סיור מיוחד בברצלונה - ${title}. הצטרפו אלינו לחוויה בלתי נשכחת!`,
      meetingPoint: 'נקודת המפגש תישלח בהודעה נפרדת',
    };
  }

  exp.get('/admin/api/messages/analyze', async (_req, res) => {
    try {
      const groupId = '120363425214664727@g.us'; // Barcelola BOT
      const messages = await app.whatsapp.getMessages(groupId, 1000);
      const sorted = messages.sort((a, b) => a.timestamp - b.timestamp);

      // Analyze all messages
      const analysis = sorted.map((msg, idx) => ({
        index: idx,
        timestamp: msg.timestamp,
        type: msg.type,
        hasMedia: msg.hasMedia,
        bodyLength: msg.body?.length || 0,
        bodyPreview: msg.body?.substring(0, 100) || '(no text)',
      }));

      res.json({ total: analysis.length, messages: analysis });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  exp.post('/admin/api/messages/send-first-two', async (req, res) => {
    try {
      const groupId = '120363425214664727@g.us'; // Barcelola BOT
      const targetPhone = req.body.phone || '+34675319188';

      // Get messages and sort by timestamp
      const messages = await app.whatsapp.getMessages(groupId, 1000);
      const sorted = messages.sort((a, b) => a.timestamp - b.timestamp);

      // Filter out system messages - find first real text message
      const firstText = sorted.find(msg => msg.type === 'chat' && msg.body && msg.body.length > 50);
      // Find first sticker
      const firstSticker = sorted.find(msg => msg.type === 'sticker');

      if (!firstText || !firstSticker) {
        res.status(400).json({
          error: 'Could not find required messages',
          foundText: !!firstText,
          foundSticker: !!firstSticker
        });
        return;
      }

      const results = [];

      // Send first text message
      console.log('Sending first Hebrew message:', firstText.body?.substring(0, 100));
      await app.whatsapp.sendDirect(targetPhone, firstText.body);
      results.push({ message: 1, type: 'text', length: firstText.body.length, sent: true });

      // Wait 2s
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Send sticker - download and re-send
      console.log('Sending first sticker');
      const targetChatId = targetPhone.replace(/^\+/, '') + '@c.us';
      await app.whatsapp.sendSticker(targetChatId, firstSticker.id);
      results.push({ message: 2, type: 'sticker', sent: true });

      res.json({
        ok: true,
        results,
        firstText: { bodyPreview: firstText.body?.substring(0, 100), length: firstText.body?.length },
        firstSticker: { type: firstSticker.type }
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });
}
