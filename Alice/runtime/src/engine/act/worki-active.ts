/**
 * Чаты, где ПРЯМО СЕЙЧАС идёт worki-ревью. В таких чатах анти-монолог (presence) ослаблен,
 * чтобы Алиса свободно нарратила прогресс работы СВОИМ голосом. Вне ревью — сдержанность как обычно.
 *
 * Заполняется worki.mod (onTickEnd, по набору незавершённых задач), читается timeline.ts.
 * Scoped и временно: как только задача доставлена/снята — чат уходит из набора.
 */
const _active = new Set<string>();

/** Заменить набор активных worki-чатов целиком (вызывается worki.mod каждый onTickEnd). */
export function syncWorkiActive(graphIds: Set<string>): void {
  _active.clear();
  for (const g of graphIds) _active.add(g);
}

/** Идёт ли в этом чате worki-ревью прямо сейчас? */
export function isWorkiActive(graphId: string): boolean {
  return _active.has(graphId);
}
