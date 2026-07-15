/**
 * Collects image/video messages from the guides group throughout the day.
 * At nightly time, re-sends them to the target groups before the broadcast.
 *
 * Design: downloads media at capture time (when the message is live and
 * downloadMedia() works). Stores the base64 data in memory. At send time,
 * creates a new MessageMedia and sends it — no forwarding needed.
 */

export interface CollectedPhoto {
  timestamp: number;
  mimetype: string;
  data: string; // base64
  caption: string;
}

export interface GuidePhotosCollector {
  /** Hook into the raw group message event. */
  onRawMessage: (msg: any, groupId: string) => void;
  /** Send all collected photos to a target chat. Returns count sent. */
  forwardAllTo: (targetChatId: string, sendFn: (chatId: string, media: { mimetype: string; data: string }, caption: string) => Promise<void>, delayMs?: number) => Promise<number>;
  /** Number of photos collected today. */
  count: () => number;
}

export function createGuidePhotosCollector(sourceGroupId: string, tz: string): GuidePhotosCollector {
  let collected: CollectedPhoto[] = [];
  let lastDateStr = todayStr(tz);

  function todayStr(timezone: string): string {
    return new Date().toLocaleDateString('en-CA', { timeZone: timezone });
  }

  function resetIfNewDay(): void {
    const today = todayStr(tz);
    if (today !== lastDateStr) {
      collected = [];
      lastDateStr = today;
    }
  }

  function onRawMessage(msg: any, groupId: string): void {
    if (groupId !== sourceGroupId) return;
    const type = typeof msg.type === 'string' ? msg.type : '';
    if (type !== 'image' && type !== 'video') return;
    if (msg.fromMe) return;

    resetIfNewDay();

    const timestamp = typeof msg.timestamp === 'number' ? msg.timestamp : Math.floor(Date.now() / 1000);
    const caption = typeof msg.body === 'string' ? msg.body : '';

    // Download media immediately while the message is live
    msg.downloadMedia().then((media: any) => {
      if (media && media.data) {
        collected.push({
          timestamp,
          mimetype: media.mimetype || 'image/jpeg',
          data: media.data,
          caption,
        });
        console.log(`[guide-photos] captured ${type} (${Math.round(media.data.length / 1024)}KB), total=${collected.length}`);
      } else {
        console.warn(`[guide-photos] downloadMedia returned null for ${type} at ${timestamp}`);
      }
    }).catch((err: any) => {
      console.error(`[guide-photos] downloadMedia failed:`, err?.message || err);
    });
  }

  async function forwardAllTo(
    targetChatId: string,
    sendFn: (chatId: string, media: { mimetype: string; data: string }, caption: string) => Promise<void>,
    delayMs = 1500,
  ): Promise<number> {
    resetIfNewDay();
    if (collected.length === 0) return 0;

    let sent = 0;
    for (const photo of collected) {
      try {
        await sendFn(targetChatId, { mimetype: photo.mimetype, data: photo.data }, photo.caption);
        sent++;
        if (sent < collected.length) {
          await new Promise((r) => setTimeout(r, delayMs));
        }
      } catch (err) {
        console.error(`[guide-photos] send failed:`, (err as Error).message);
      }
    }
    collected = [];
    return sent;
  }

  function count(): number {
    resetIfNewDay();
    return collected.length;
  }

  return { onRawMessage, forwardAllTo, count };
}
