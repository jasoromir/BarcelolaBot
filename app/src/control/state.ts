import type { ControlState } from '../persistence/controlState.js';

const KEY_PAUSED = 'automations_paused';
const KEY_NEW_CONTACT_RESTRICTED = 'new_contact_restricted';

export class ControlStateService {
  constructor(private readonly store: ControlState) {}

  isPaused(): boolean {
    return this.store.get(KEY_PAUSED) === 'true';
  }

  pause(): void {
    this.store.set(KEY_PAUSED, 'true');
  }

  resume(): void {
    this.store.set(KEY_PAUSED, 'false');
  }

  /**
   * True while WhatsApp has flagged this linked-device account for suspected
   * bulk/automated messaging and restricted it from starting new chats (seen
   * 2026-07-07 — WhatsApp's own UI message: "no podrás iniciar nuevos chats").
   * While true, first-contact DMs to phones never messaged before are held in
   * the pending queue instead of sent, so we don't keep tripping the
   * restriction. Existing conversations are unaffected either way. Defaults
   * to true (restricted) until explicitly cleared via /admin once WhatsApp
   * lifts it.
   */
  isNewContactRestricted(): boolean {
    const v = this.store.get(KEY_NEW_CONTACT_RESTRICTED);
    return v === null ? true : v === 'true';
  }

  setNewContactRestricted(restricted: boolean): void {
    this.store.set(KEY_NEW_CONTACT_RESTRICTED, restricted ? 'true' : 'false');
  }
}
