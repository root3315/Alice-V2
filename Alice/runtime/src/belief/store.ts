/**
 * BeliefStore — хранилище убеждений, независимое от nodeAttrs.
 *
 * Ключ: `${entityId}::${attribute}`
 * Значение: BeliefTriple
 *
 * Убеждения о непрерывных величинах (близость, интенсивность интереса и т.п.) с байесовским обновлением.
 *
 * @see paper-pomdp/ §3
 * @see docs/adr/123-crystallization-substrate-generalization.md §D1, §D2
 */
import { decayBelief } from "./decay.js";
import { type BeliefDecayParams, type BeliefTriple, DEFAULT_BELIEF_DECAY } from "./types.js";
import { type UpdateOptions, updateBelief } from "./update.js";

/** Карта записей убеждений. */
export type BeliefEntryMap = Record<string, { mu: number; sigma2: number; tObs: number }>;

/**
 * Формат сериализации.
 *
 * Содержит только entries. fromDict корректно игнорирует лишние поля в старом JSON
 * (changelog, windows, drifts) — без исключений.
 */
export interface BeliefDict {
  entries: BeliefEntryMap;
}

/** Дисперсия по умолчанию для нового убеждения (высокая неопределённость). */
const DEFAULT_SIGMA2 = 1.0;

function makeKey(entityId: string, attr: string): string {
  return `${entityId}::${attr}`;
}

export class BeliefStore {
  private beliefs = new Map<string, BeliefTriple>();

  /** ADR-123 D2: Карта «домен → параметры затухания». Для незарегистрированных доменов используются defaultParams. */
  private domainDecayParams = new Map<string, BeliefDecayParams>();

  get(entityId: string, attr: string): BeliefTriple | undefined {
    return this.beliefs.get(makeKey(entityId, attr));
  }

  set(entityId: string, attr: string, belief: BeliefTriple): void {
    this.beliefs.set(makeKey(entityId, attr), belief);
  }

  /** Возвращает убеждение, а при его отсутствии — значение по умолчанию с высокой неопределённостью. */
  getOrDefault(entityId: string, attr: string, defaultMu = 0): BeliefTriple {
    return (
      this.beliefs.get(makeKey(entityId, attr)) ?? {
        mu: defaultMu,
        sigma2: DEFAULT_SIGMA2,
        tObs: 0,
      }
    );
  }

  /**
   * Метод байесовского обновления.
   *
   * F4: `nowMs` вместо `tick` — tObs хранит настенное время в мс, независимо от интервала тика.
   * @see docs/adr/123-crystallization-substrate-generalization.md §D1
   */
  update(
    entityId: string,
    attr: string,
    observation: number,
    channel: "structural" | "semantic",
    nowMs: number,
    options?: UpdateOptions,
  ): BeliefTriple {
    const old = this.getOrDefault(entityId, attr);
    const updated = updateBelief(old, observation, channel, nowMs, options);
    this.set(entityId, attr, updated);
    return updated;
  }

  /**
   * ADR-123 D2: Регистрирует параметры затухания для домена.
   * domainPrefix, например: "trait:", "jargon:", "expression:"
   */
  registerDomainDecay(domainPrefix: string, params: BeliefDecayParams): void {
    this.domainDecayParams.set(domainPrefix, params);
  }

  /**
   * Применяет временно́е затухание ко всем убеждениям.
   * F4: параметр изменён с `tick` на `nowMs` — скорость затухания не зависит от интервала тика.
   * ADR-123 D2: используются зарегистрированные параметры домена вместо хардкода key.includes("::trait:").
   * @see docs/adr/89-impression-formation-system.md §Phase 1B
   * @see docs/adr/123-crystallization-substrate-generalization.md §D2
   */
  decayAll(nowMs: number, params: BeliefDecayParams = DEFAULT_BELIEF_DECAY): void {
    for (const [key, belief] of this.beliefs) {
      let effectiveParams = params;
      for (const [prefix, p] of this.domainDecayParams) {
        if (key.includes(`::${prefix}`)) {
          effectiveParams = p;
          break;
        }
      }
      this.beliefs.set(key, decayBelief(belief, nowMs, effectiveParams));
    }
  }

  /**
   * Вычисляет энтропию Шеннона убеждения.
   * H(b) = 0.5 · ln(2πe · σ²)
   * Дифференциальная энтропия нормального распределения. Чем больше σ² → тем выше H → тем выше неопределённость.
   */
  entropy(entityId: string, attr: string): number {
    const b = this.beliefs.get(makeKey(entityId, attr));
    if (!b) return 0.5 * Math.log(2 * Math.PI * Math.E * DEFAULT_SIGMA2);
    return 0.5 * Math.log(2 * Math.PI * Math.E * b.sigma2);
  }

  /**
   * Возвращает все убеждения для заданного entity с указанным префиксом attr.
   * @example getByEntityAttrPrefix("contact:david", "trait:") → [["trait:warmth", belief], ...]
   * @see docs/adr/89-impression-formation-system.md §Wave 2B
   */
  getByEntityAttrPrefix(
    entityId: string,
    attrPrefix: string,
  ): Array<[attr: string, belief: BeliefTriple]> {
    const keyPrefix = `${entityId}::${attrPrefix}`;
    const results: Array<[string, BeliefTriple]> = [];
    for (const [key, belief] of this.beliefs) {
      if (key.startsWith(keyPrefix)) {
        const attr = key.slice(entityId.length + 2);
        results.push([attr, belief]);
      }
    }
    return results;
  }

  /** Количество записей убеждений. */
  get size(): number {
    return this.beliefs.size;
  }

  /** Очистить. */
  clear(): void {
    this.beliefs.clear();
  }

  /** Сериализовать в структурированный словарь. */
  toDict(): BeliefDict {
    const entries: BeliefEntryMap = {};
    for (const [key, b] of this.beliefs) {
      entries[key] = { mu: b.mu, sigma2: b.sigma2, tObs: b.tObs };
    }
    return { entries };
  }

  /**
   * Десериализовать из структурированного словаря.
   * Корректно игнорирует лишние поля в старом JSON (changelog, windows, drifts).
   */
  static fromDict(data: BeliefDict): BeliefStore {
    const store = new BeliefStore();
    for (const [key, entry] of Object.entries(data.entries ?? {})) {
      store.beliefs.set(key, { mu: entry.mu, sigma2: entry.sigma2, tObs: entry.tObs });
    }
    return store;
  }

  /** Восстановить из другого store (замена на месте). */
  restoreFrom(other: BeliefStore): void {
    this.beliefs.clear();
    const dict = other.toDict();
    for (const [key, entry] of Object.entries(dict.entries)) {
      this.beliefs.set(key, { mu: entry.mu, sigma2: entry.sigma2, tObs: entry.tObs });
    }
  }
}
