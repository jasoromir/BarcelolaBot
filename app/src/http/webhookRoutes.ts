import type { Express } from 'express';
import type { App } from '../app.js';
import { handleBookingWebhook } from '../webhook/bookingHandler.js';

export function registerWebhookRoutes(exp: Express, app: App): void {
  exp.post('/webhook/wix', async (req, res) => {
    // Respond 200 quickly; process asynchronously. Dedup ensures Wix retries are safe.
    res.status(200).json({ received: true });
    try {
      await handleBookingWebhook({
        payload: req.body,
        config: app.config,
        dedup: app.webhookDedup,
        sender: app.dmSender,
        logger: app.logger,
        isPaused: () => app.controlState.isPaused(),
      });
    } catch (err) {
      app.logger.error({
        source: 'http',
        eventType: 'webhook_handler_crash',
        message: (err as Error).message,
      });
    }
  });
}
