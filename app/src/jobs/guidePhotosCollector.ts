/**
 * Collects image/video messages as they arrive in real-time.
 * Downloads media immediately (while the message is live and decryption keys
 * are available in memory) and stores the base64 data. At send time, creates
 * a fresh MessageMedia and sends it as a new message — no forwarding needed.
 *
 * Why download at capture time:
 * - `getMessageById` / `chat.fetchMessages` throw on this LID-migrated session
 * - `msg.forward()` requires a valid message lookup (same broken path)
 * - Only the live message object at receive time has working decryption keys
 *
 * Supports two source modes:
 * - Group messages (production): via onRawGroupMessage hook
 * - DM images (testing): via onDmImage hook, filtered by phone number
 */

export interface CollectedPhoto {
  timestamp: number;
  mimetype: string;
  data: string; // base64
  caption: string;
  source: string; // group id or phone E.164
}

export interface GuidePhotosCollector {
  onRawMessage: (msg: any, groupId: string) => void;
  onDmImage: (msg: any, fromPhone: string) => void;
  forwardAllTo: (
    targetChatId: string,
    sendFn: (chatId: string, media: { mimetype: string; data: string }, caption: string) => Promise<void>,
    delayMs?: number,
  ) => Promise<number>;
  count: () => number;
  getCollected: () => ReadonlyArray<CollectedPhoto>;
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

  function captureMedia(msg: any, source: string): void {
    resetIfNewDay();

    const type = typeof msg.type === 'string' ? msg.type : '';
    const timestamp = typeof msg.timestamp === 'number' ? msg.timestamp : Math.floor(Date.now() / 1000);
    const caption = typeof msg.body === 'string' ? msg.body : '';
    const id = msg?.id?._serialized ?? '(unknown)';

    console.log(
      `[guide-photos] capturing: id=${id} type=${type} hasMedia=${msg?.hasMedia} source=${source}`,
    );

    // Download immediately — the message is live now but won't be accessible
    // later via getMessageById on this LID-migrated session.
    const downloadPromise: Promise<any> = Promise.race([
      msg.downloadMedia(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('downloadMedia timeout 30s')), 30_000),
      ),
    ]);

    downloadPromise
      .then((media: any) => {
        if (media && media.data) {
          collected.push({
            timestamp,
            mimetype: media.mimetype || (type === 'video' ? 'video/mp4' : 'image/jpeg'),
            data: media.data,
            caption,
            source,
          });
          console.log(
            `[guide-photos] ✓ captured ${type} (${Math.round(media.data.length / 1024)}KB) total=${collected.length}`,
          );
        } else {
          console.warn(`[guide-photos] ✗ downloadMedia returned null for ${type} id=${id}`);
        }
      })
      .catch((err: any) => {
        console.error(
          `[guide-photos] ✗ downloadMedia failed for ${type} id=${id}: ${err?.message ?? err}`,
        );
      });
  }

  function onRawMessage(msg: any, groupId: string): void {
    if (groupId !== sourceGroupId) return;
    const type = typeof msg.type === 'string' ? msg.type : '';
    if (type !== 'image' && type !== 'video') return;
    if (msg.fromMe) return;
    captureMedia(msg, groupId);
  }

  function onDmImage(msg: any, fromPhone: string): void {
    const type = typeof msg.type === 'string' ? msg.type : '';
    if (type !== 'image' && type !== 'video') return;
    captureMedia(msg, fromPhone);
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

  function getCollected(): ReadonlyArray<CollectedPhoto> {
    resetIfNewDay();
    return collected;
  }

  return { onRawMessage, onDmImage, forwardAllTo, count, getCollected };
}
