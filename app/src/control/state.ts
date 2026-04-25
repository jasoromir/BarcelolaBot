import type { ControlState } from '../persistence/controlState.js';

const KEY_PAUSED = 'automations_paused';

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
}
