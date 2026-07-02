import type { Express, Request, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
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

  // Moderation audit log — every spam detection/action with the sender's phone,
  // so a wrongly-removed customer can be identified and re-invited.
  exp.get('/admin/api/moderation/actions', (req, res) => {
    const limit = Math.min(Number((req.query.limit as string) ?? 100), 500);
    res.json({ actions: app.spamActions.recent(limit) });
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
      reminders: app.reminders,
      logger: app.logger,
      dataDir: process.env.DATA_DIR ?? './data',
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

  // Seed or refresh tours.yaml from Wix. Writes to the persistent volume
  // overlay so subsequent redeploys pick up the changes. Preserves any
  // hand-curated Hebrew copy already present for a service_id.
  exp.post('/admin/api/tours/sync-from-wix', async (req, res) => {
    try {
      const dryRun = Boolean(req.body?.dry_run);
      const services = await app.wix.listServices();
      const existing = app.config.tours.tours;
      const merged: Record<
        string,
        {
          name_he: string;
          emoji: string;
          description_he: string;
          meeting_point_he: string;
          google_maps_url?: string;
        }
      > = {};
      for (const s of services) {
        if (s.hidden) continue;
        const prev = existing[s.id];
        merged[s.id] = {
          name_he: prev?.name_he || s.name || 'סיור',
          emoji: prev?.emoji || '🌻',
          description_he: prev?.description_he || s.description || '',
          meeting_point_he: prev?.meeting_point_he || s.location || '',
          ...(prev?.google_maps_url ? { google_maps_url: prev.google_maps_url } : {}),
        };
      }
      // Carry forward entries that exist locally but weren't returned by Wix
      // (in case Wix is paging oddly, or service is temporarily filtered out
      // — we never want to silently drop hand-curated content).
      for (const [id, entry] of Object.entries(existing)) {
        if (!merged[id]) merged[id] = entry;
      }

      const yamlBody = yaml.dump({ tours: merged }, { sortKeys: false, lineWidth: 200 });

      if (dryRun) {
        res.json({
          ok: true,
          dry_run: true,
          services_count: services.length,
          merged_count: Object.keys(merged).length,
          preview: yamlBody,
        });
        return;
      }

      const overlayDir = path.join(path.resolve(process.env.DATA_DIR ?? './data'), 'config');
      if (!fs.existsSync(overlayDir)) fs.mkdirSync(overlayDir, { recursive: true });
      const target = path.join(overlayDir, 'tours.yaml');
      fs.writeFileSync(target, yamlBody, 'utf8');
      app.reloadConfig();
      res.json({
        ok: true,
        services_count: services.length,
        merged_count: Object.keys(merged).length,
        path: target,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Send an arbitrary text body to a chat (group or DM). Handy for ad-hoc
  // announcements + scripted test sequences run from the CLI.
  exp.post('/admin/api/send', async (req, res) => {
    try {
      const chatId = req.body?.chat_id as string | undefined;
      const body = req.body?.body as string | undefined;
      if (!chatId || !body) {
        res.status(400).json({ error: 'chat_id and body required' });
        return;
      }
      let result;
      if (chatId.endsWith('@g.us')) {
        result = await app.whatsapp.sendToGroup(chatId, body);
      } else {
        // Accept @c.us jids or raw +E.164.
        const phone = chatId.endsWith('@c.us')
          ? `+${chatId.replace(/@c\.us$/, '')}`
          : chatId;
        result = await app.whatsapp.sendDirect(phone, body);
      }
      res.json({ ok: true, result });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Patch one or more tours in the overlay tours.yaml. Body: { tours: {
  // "<service_id>": { name_he?, emoji?, description_he?, meeting_point_he?,
  //                   google_maps_url? } } }
  // Only fields present in the patch are updated. Unknown service_ids are
  // added as new entries. Entries not mentioned in the patch are preserved.
  exp.post('/admin/api/tours/patch', async (req, res) => {
    try {
      const patch = (req.body?.tours ?? {}) as Record<
        string,
        {
          name_he?: string;
          emoji?: string;
          description_he?: string;
          meeting_point_he?: string;
          google_maps_url?: string;
        }
      >;
      if (typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length) {
        res.status(400).json({ error: 'tours object required with at least one entry' });
        return;
      }
      const existing = { ...app.config.tours.tours };
      for (const [id, fields] of Object.entries(patch)) {
        const prev = existing[id] ?? {
          name_he: '',
          emoji: '🌻',
          description_he: '',
          meeting_point_he: '',
        };
        existing[id] = {
          name_he: fields.name_he ?? prev.name_he,
          emoji: fields.emoji ?? prev.emoji,
          description_he: fields.description_he ?? prev.description_he,
          meeting_point_he: fields.meeting_point_he ?? prev.meeting_point_he,
          ...(fields.google_maps_url ?? prev.google_maps_url
            ? { google_maps_url: fields.google_maps_url ?? prev.google_maps_url }
            : {}),
        };
      }
      const yamlBody = yaml.dump({ tours: existing }, { sortKeys: false, lineWidth: 200 });
      const overlayDir = path.join(path.resolve(process.env.DATA_DIR ?? './data'), 'config');
      if (!fs.existsSync(overlayDir)) fs.mkdirSync(overlayDir, { recursive: true });
      const target = path.join(overlayDir, 'tours.yaml');
      fs.writeFileSync(target, yamlBody, 'utf8');
      app.reloadConfig();
      res.json({ ok: true, patched: Object.keys(patch).length, total: Object.keys(existing).length });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Inspect stickers in the BARCELOLA BOT group. Returns metadata for the
  // oldest N sticker messages so we can confirm which one we want to resend.
  exp.get('/admin/api/stickers/list', async (req, res) => {
    try {
      const groupId = (req.query.group_id as string) || '120363425214664727@g.us';
      const limit = Math.min(Number(req.query.limit ?? 1000), 2000);
      const messages = await app.whatsapp.getMessages(groupId, limit);
      const stickers = messages
        .filter((m) => m.type === 'sticker')
        .sort((a, b) => a.timestamp - b.timestamp)
        .slice(0, 10)
        .map((m) => ({
          id: m.id,
          timestamp: m.timestamp,
          timestampIso: new Date(m.timestamp * 1000).toISOString(),
          hasMedia: m.hasMedia,
        }));
      res.json({ groupId, totalScanned: messages.length, stickerCount: stickers.length, stickers });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Extract raw sticker bytes from whatsapp-web.js's Chromium page, save to
  // DATA_DIR/assets/sticker.webp, then send as a native sticker (no "forwarded"
  // label). Caches the asset so subsequent sends don't need the source message.
  exp.post('/admin/api/stickers/capture-and-send', async (req, res) => {
    try {
      const groupId = (req.body?.group_id as string) || '120363425214664727@g.us';
      const targetChatId = (req.body?.target_chat_id as string) || groupId;
      let stickerMessageId = req.body?.message_id as string | undefined;
      if (!stickerMessageId) {
        const messages = await app.whatsapp.getMessages(groupId, 1000);
        const stickers = messages
          .filter((m) => m.type === 'sticker')
          .sort((a, b) => b.timestamp - a.timestamp);
        const pick = stickers[0];
        if (!pick) {
          res.status(404).json({ error: 'no sticker found in group' });
          return;
        }
        stickerMessageId = pick.id;
      }

      const dataDir = path.resolve(process.env.DATA_DIR ?? './data');
      const assetsDir = path.join(dataDir, 'assets');
      if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });
      const assetPath = path.join(assetsDir, 'welcome-sticker.webp');

      let bytes: { data: string; mimetype: string } | null = null;
      // Re-use the cached asset if we've already captured one.
      if (fs.existsSync(assetPath) && req.body?.force !== true) {
        const buf = fs.readFileSync(assetPath);
        bytes = { data: buf.toString('base64'), mimetype: 'image/webp' };
      } else {
        bytes = await app.whatsapp.downloadStickerBytes(stickerMessageId);
        if (!bytes) {
          res.status(500).json({
            error:
              'downloadStickerBytes returned null — sticker media not accessible, see container logs',
          });
          return;
        }
        fs.writeFileSync(assetPath, Buffer.from(bytes.data, 'base64'));
      }

      const dataUrl = `data:${bytes.mimetype};base64,${bytes.data}`;
      const sent = await app.whatsapp.sendStickerFromDataUrl(targetChatId, dataUrl);
      res.json({
        ok: true,
        sourceStickerId: stickerMessageId,
        targetChatId,
        assetPath,
        assetBytes: Buffer.byteLength(bytes.data, 'base64'),
        sent,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Forward a sticker to a target chat. Unlike download+reupload, forwarding
  // preserves the sticker via WhatsApp server-side without requiring us to
  // fetch the media payload (which hangs on old messages + returns null on
  // outbound messages sent by the bot itself).
  exp.post('/admin/api/stickers/forward', async (req, res) => {
    try {
      const groupId = (req.body?.group_id as string) || '120363425214664727@g.us';
      const targetChatId = (req.body?.target_chat_id as string) || groupId;
      let stickerMessageId = req.body?.message_id as string | undefined;
      if (!stickerMessageId) {
        const messages = await app.whatsapp.getMessages(groupId, 1000);
        // Prefer incoming stickers (false_*); skip fromMe=true ones since their
        // media isn't downloadable but forwarding works on either.
        const stickers = messages
          .filter((m) => m.type === 'sticker')
          .sort((a, b) => b.timestamp - a.timestamp); // newest first
        const oldestIncoming = stickers.find((s) => s.id.startsWith('false_'));
        const pick = oldestIncoming ?? stickers[0];
        if (!pick) {
          res.status(404).json({ error: 'no sticker found in group' });
          return;
        }
        stickerMessageId = pick.id;
      }
      const result = await app.whatsapp.forwardMessage(stickerMessageId, targetChatId);
      res.json({ ok: true, sourceStickerId: stickerMessageId, targetChatId, result });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  exp.get('/admin/api/debug/link-preview', async (req, res) => {
    const url = (req.query.url as string) || 'https://www.barcelola-tours.com/barcelolatours';
    try {
      const result = await app.whatsapp.debugLinkPreview(url);
      res.json({ url, preview: result });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Re-send a specific sticker into a target chat (default: back to BARCELOLA
  // BOT group so we can eyeball it live). Surfaces any sendSticker errors now
  // that the client throws on hasMedia=false or null downloads.
  exp.post('/admin/api/stickers/send', async (req, res) => {
    try {
      const groupId = (req.body?.group_id as string) || '120363425214664727@g.us';
      const targetChatId = (req.body?.target_chat_id as string) || groupId;
      // If a specific sticker id wasn't provided, pick the oldest sticker.
      let stickerMessageId = req.body?.message_id as string | undefined;
      if (!stickerMessageId) {
        const messages = await app.whatsapp.getMessages(groupId, 1000);
        const oldestSticker = messages
          .filter((m) => m.type === 'sticker')
          .sort((a, b) => a.timestamp - b.timestamp)[0];
        if (!oldestSticker) {
          res.status(404).json({ error: 'no sticker found in group' });
          return;
        }
        stickerMessageId = oldestSticker.id;
      }
      const result = await app.whatsapp.sendSticker(targetChatId, stickerMessageId);
      res.json({ ok: true, sourceStickerId: stickerMessageId, targetChatId, result });
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
