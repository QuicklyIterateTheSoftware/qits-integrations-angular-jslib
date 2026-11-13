import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { QitsPwaUpdates } from './qits-pwa-updates';

/**
 * The person's say over a new version (ticket qits-2152), placed once in the app's shell:
 *
 * - hidden while the tab is `current`;
 * - at `ready`, "A new version is ready" with **Reload** ({@link QitsPwaUpdates.apply}) and
 *   **Later**, which hides it until the next `VERSION_READY`;
 * - at `broken`, "This version can no longer be loaded" with **Reload** only;
 * - a Reload a guard refuses shows the guards' reasons.
 *
 * Styled only with the theme's semantic tokens (`--color-surface`, `--color-fg`, `--color-accent`).
 */
@Component({
  selector: 'qits-pwa-update-prompt',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (visible()) {
      <section class="qits-pwa-update" role="status" aria-live="polite">
        <p class="qits-pwa-update-message">
          {{ broken() ? 'This version can no longer be loaded' : 'A new version is ready' }}
        </p>
        @if (reasons().length > 0) {
          <ul class="qits-pwa-update-reasons">
            @for (reason of reasons(); track $index) {
              <li>{{ reason }}</li>
            }
          </ul>
        }
        <div class="qits-pwa-update-actions">
          <button
            type="button"
            class="qits-pwa-update-reload"
            data-track-event="pwa-update-reload"
            [disabled]="applying()"
            (click)="reload()"
          >
            Reload
          </button>
          @if (!broken()) {
            <button
              type="button"
              class="qits-pwa-update-later"
              data-track-event="pwa-update-later"
              (click)="later()"
            >
              Later
            </button>
          }
        </div>
      </section>
    }
  `,
  styles: `
    .qits-pwa-update {
      position: fixed;
      inset-inline: 1rem;
      bottom: 1rem;
      z-index: 1000;
      max-width: 28rem;
      margin-inline: auto;
      padding: 0.75rem 1rem;
      border: 1px solid var(--color-accent);
      border-radius: 0.5rem;
      background: var(--color-surface);
      color: var(--color-fg);
    }
    .qits-pwa-update-message {
      margin: 0 0 0.5rem;
      font-weight: 600;
    }
    .qits-pwa-update-reasons {
      margin: 0 0 0.5rem;
      padding-inline-start: 1.25rem;
    }
    .qits-pwa-update-actions {
      display: flex;
      gap: 0.5rem;
      justify-content: flex-end;
    }
    button {
      padding: 0.25rem 0.75rem;
      border: 1px solid var(--color-accent);
      border-radius: 0.25rem;
      font: inherit;
      cursor: pointer;
    }
    .qits-pwa-update-reload {
      background: var(--color-accent);
      color: var(--color-surface);
    }
    .qits-pwa-update-later {
      background: var(--color-surface);
      color: var(--color-accent);
    }
    button:disabled {
      cursor: progress;
      opacity: 0.6;
    }
  `,
})
export class QitsPwaUpdatePrompt {
  private readonly updates = inject(QitsPwaUpdates);
  /** The `readyCount` at the last Later; the prompt stays hidden until a new version moves it. */
  private readonly dismissedAt = signal<number | null>(null);

  protected readonly broken = computed(() => this.updates.state() === 'broken');
  protected readonly visible = computed(() => {
    const state = this.updates.state();
    if (state === 'broken') return true;
    return state === 'ready' && this.dismissedAt() !== this.updates.readyCount();
  });
  protected readonly reasons = signal<readonly string[]>([]);
  protected readonly applying = signal(false);

  protected async reload(): Promise<void> {
    this.applying.set(true);
    this.reasons.set([]);
    try {
      const result = await this.updates.apply();
      if (!result.applied) this.reasons.set(result.reasons);
    } finally {
      this.applying.set(false);
    }
  }

  protected later(): void {
    this.reasons.set([]);
    this.dismissedAt.set(this.updates.readyCount());
  }
}
