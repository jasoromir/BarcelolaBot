import express, { Express } from 'express';
import cookieParser from 'cookie-parser';
import type { App } from '../app';
import { registerAdminRoutes } from './adminRoutes';
import { registerWebhookRoutes } from './webhookRoutes';

export function createHttpServer(app: App): Express {
  const exp = express();
  exp.use(express.json({ limit: '1mb' }));
  exp.use(cookieParser());

  exp.get('/healthz', (_req, res) => {
    const state = app.whatsapp.state();
    res.json({
      wa: state.kind,
      paused: app.controlState.isPaused(),
      uptime_s: Math.floor(process.uptime()),
    });
  });

  registerWebhookRoutes(exp, app);
  registerAdminRoutes(exp, app);
  return exp;
}
