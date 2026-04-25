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

export function registerAdminRoutes(exp: Express, app: App, cfg?: AdminConfig): void {
  const effective: AdminConfig =
    cfg ?? {
      passwordHash: process.env.ADMIN_PASSWORD_HASH ?? '',
      cookieSecret: process.env.SESSION_COOKIE_SECRET ?? 'dev-insecure',
      webDir: path.resolve(process.cwd(), 'web'),
    };
  const auth = createAuth(effective);

  exp.get('/admin', (_req: Request, res: Response) => {
    res.sendFile(path.join(effective.webDir, 'admin.html'));
  });
  exp.get('/admin/admin.js', (_req, res) => res.sendFile(path.join(effective.webDir, 'admin.js')));
  exp.get('/admin/admin.css', (_req, res) => res.sendFile(path.join(effective.webDir, 'admin.css')));

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
    if (action === 'close') await svc.closeAll(targets);
    else await svc.openAll(targets);
    res.json({ ok: true, targets });
  }
  exp.post('/admin/api/groups/close-all', async (_req, res) => bulkGroupAction('close', res));
  exp.post('/admin/api/groups/open-all', async (_req, res) => bulkGroupAction('open', res));

  exp.post('/admin/api/config/reload', (_req, res) => {
    try {
      app.reloadConfig();
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ ok: false, error: (err as Error).message });
    }
  });
}
