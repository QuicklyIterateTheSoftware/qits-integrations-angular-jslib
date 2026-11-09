import type { Outcome } from './outcomes';

/**
 * The trigger mark of `entries`: `<interaction>:<outcome>` each, space-separated in the order
 * given, such as `create-work-item:created create-work-item:refused`. Bind it as
 * `[attr.data-qits-outcome]` where neither `QitsExit` nor `QitsTriggers` fits. A plain attribute, so
 * it survives into a frozen page, and the interaction span reads it (`app.interaction.outcome`).
 */
export function outcomeMark(
  ...entries: readonly Pick<Outcome, 'interaction' | 'outcome'>[]
): string {
  return entries.map((entry) => `${entry.interaction}:${entry.outcome}`).join(' ');
}
