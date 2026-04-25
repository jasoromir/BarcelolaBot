import type { Express } from 'express';
import type { App } from '../app.js';
import { handleBookingWebhook } from '../webhook/bookingHandler.js';

export function registerWebhookRoutes(exp: Express, app: App): void {
  exp.post('/webhook/wix', async (req, res) => {
    try {
      const outcome = await handleBookingWebhook({
        payload: req.body,
        config: app.config,
        dedup: app.webhookDedup,
        sender: app.dmSender,
        logger: app.logger,
        isPaused: () => app.controlState.isPaused(),
      });
      // Always 200 so Wix retries stop; we've either sent, skipped, or deferred-to-queue.
      res.status(200).json({ received: true, outcome: outcome.outcome });
    } catch (err) {
      app.logger.error({
        source: 'http',
        eventType: 'webhook_handler_crash',
        message: (err as Error).message,
      });
      // 500 so Wix retries
      res.status(500).json({ received: false });
    }
  });
}
