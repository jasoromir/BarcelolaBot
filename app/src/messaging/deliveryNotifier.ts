import type { WhatsAppClient } from '../whatsapp/types.js';
import type { AppLogger } from '../log/logger.js';

export interface DeliveryNotifierDeps {
  wa: WhatsAppClient;
  logger: AppLogger;
  /** Barcelola BOT worker group id (@g.us) where delivery pings are posted. */
  workerGroupId: string;
  /** How long to wait for a delivery ack before assuming failure. */
  confirmTimeoutMs?: number;
  /** How long to wait before the one follow-up recheck (see confirmWithFollowUp). */
  followUpDelayMs?: number;
  /** How long the follow-up recheck itself polls for. */
  followUpTimeoutMs?: number;
}

export interface SendAndAnnounceInput {
  phone: string;
  body: string;
  /** Human label for the ping, e.g. "welcome", "confirmation", "reminder". */
  kind: string;
  /** Customer name shown in the ping. */
  name: string;
}

export type DeliveryResult =
  | { status: 'delivered'; ack: number; messageId: string }
  | { status: 'not_delivered'; ack: number; messageId: string }
  | { status: 'unregistered' }
  | { status: 'error'; error: string };

/**
 * Sends a customer DM, waits for WhatsApp to confirm delivery (ack >= 2), and
 * only then posts a success note to the worker group. If delivery can't be
 * confirmed — number not on WhatsApp, or ack never reaches "delivered" — it
 * posts a warning instead, so a silently-dropped message is visible rather than
 * falsely reported as sent. Pings are in English per operator preference.
 */
export function createDeliveryNotifier(deps: DeliveryNotifierDeps) {
  const confirmTimeoutMs = deps.confirmTimeoutMs ?? 20_000;
  const followUpDelayMs = deps.followUpDelayMs ?? 45_000;
  const followUpTimeoutMs = deps.followUpTimeoutMs ?? 20_000;

  /**
   * ack -1 is a genuine hard failure (WhatsApp confirms zero devices ever
   * received it — the "No LID for user" signal). ack 0/1 just means "still in
   * flight, not yet confirmed delivered" — plenty of real recipients ack up to
   * a minute later (phone briefly offline, poor connection, etc.), so treating
   * that as a final failure after only ~20s produces false "NOT DELIVERED"
   * alerts for messages that go on to deliver normally. When the first poll
   * comes back ambiguous (not yet >=2, but not a hard -1 either), wait once
   * more and recheck before concluding it actually failed.
   */
  async function confirmWithFollowUp(messageId: string): Promise<number> {
    const first = await deps.wa.confirmDelivery(messageId, confirmTimeoutMs);
    if (first >= 2 || first === -1) return first;
    await new Promise((r) => setTimeout(r, followUpDelayMs));
    return deps.wa.confirmDelivery(messageId, followUpTimeoutMs);
  }

  async function ping(text: string): Promise<void> {
    try {
      await deps.wa.sendToGroup(deps.workerGroupId, text);
    } catch (err) {
      deps.logger.error({
        source: 'delivery',
        eventType: 'ping_failed',
        message: `failed to post delivery ping: ${(err as Error).message}`,
      });
    }
  }

  /** Loud, action-oriented failure ping so staff manually contact the customer. */
  function failurePing(kind: string, name: string, phone: string, reason: string): string {
    return (
      `🚨 *NOT DELIVERED* — ${kind} to *${name}*\n` +
      `📞 ${phone}\n` +
      `Reason: ${reason}\n` +
      `👉 Please contact this customer manually (call / SMS / saved WhatsApp contact).`
    );
  }

  async function sendAndAnnounce(input: SendAndAnnounceInput): Promise<DeliveryResult> {
    const { phone, body, kind, name } = input;

    // Pre-check registration so an unreachable number is reported clearly and we
    // don't wait the full confirm timeout on a number that can never deliver.
    let resolved: string | null;
    try {
      resolved = await deps.wa.resolveNumberId(phone);
    } catch (err) {
      resolved = null;
      deps.logger.warn({
        source: 'delivery',
        eventType: 'resolve_failed',
        message: `resolveNumberId threw for ${phone}: ${(err as Error).message}`,
      });
    }
    if (resolved === null) {
      await ping(failurePing(kind, name, phone, 'number not on WhatsApp / unregistered'));
      deps.logger.warn({
        source: 'delivery',
        eventType: 'unregistered_number',
        message: `${kind} to ${name} ${phone}: unregistered`,
      });
      return { status: 'unregistered' };
    }

    let messageId: string;
    try {
      const r = await deps.wa.sendDirect(phone, body);
      messageId = r.messageId;
    } catch (err) {
      await ping(failurePing(kind, name, phone, `send error — ${(err as Error).message}`));
      deps.logger.error({
        source: 'delivery',
        eventType: 'send_failed',
        message: `${kind} to ${name} ${phone}: ${(err as Error).message}`,
      });
      return { status: 'error', error: (err as Error).message };
    }

    const ack = await confirmWithFollowUp(messageId);
    if (ack >= 2) {
      await ping(`✅ Sent ${kind} to ${name}: ${phone}`);
      deps.logger.info({
        source: 'delivery',
        eventType: 'delivered',
        message: `${kind} to ${name} ${phone} delivered (ack=${ack})`,
        metadata: { phone, messageId, ack },
      });
      return { status: 'delivered', ack, messageId };
    }

    await ping(failurePing(kind, name, phone, `not confirmed delivered (ack=${ack})`));
    deps.logger.warn({
      source: 'delivery',
      eventType: 'not_delivered',
      message: `${kind} to ${name} ${phone} not confirmed (ack=${ack})`,
      metadata: { phone, messageId, ack },
    });
    return { status: 'not_delivered', ack, messageId };
  }

  /**
   * For messages already sent through another path (e.g. DirectMessageSender,
   * which owns allowlist + offline-queue logic): confirm delivery of an existing
   * messageId and post the same delivered/failed ping. Does not re-send.
   */
  async function confirmAndAnnounce(input: {
    messageId: string;
    phone: string;
    kind: string;
    name: string;
  }): Promise<DeliveryResult> {
    const { messageId, phone, kind, name } = input;
    const ack = await confirmWithFollowUp(messageId);
    if (ack >= 2) {
      await ping(`✅ Sent ${kind} to ${name}: ${phone}`);
      deps.logger.info({
        source: 'delivery',
        eventType: 'delivered',
        message: `${kind} to ${name} ${phone} delivered (ack=${ack})`,
        metadata: { phone, messageId, ack },
      });
      return { status: 'delivered', ack, messageId };
    }
    await ping(failurePing(kind, name, phone, `not confirmed delivered (ack=${ack})`));
    deps.logger.warn({
      source: 'delivery',
      eventType: 'not_delivered',
      message: `${kind} to ${name} ${phone} not confirmed (ack=${ack})`,
      metadata: { phone, messageId, ack },
    });
    return { status: 'not_delivered', ack, messageId };
  }

  return { sendAndAnnounce, confirmAndAnnounce };
}

export type DeliveryNotifier = ReturnType<typeof createDeliveryNotifier>;
