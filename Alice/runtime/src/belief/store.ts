/**
 * BeliefStore — 独立于 nodeAttrs 的信念存储。
 *
 * 键: `${entityId}::${attribute}`
 * 值: BeliefTriple
 *
 * 连续值信念（亲密度、兴趣强度等），带贝叶斯更新。
 *
 * @see paper-pomdp/ §3
 * @see docs/adr/123-crystallization-substrate-generalization.md §D1, §D2
 */
import { decayBelief } from "./decay.js";
import { type BeliefDecayParams, type BeliefTriple, DEFAULT_BELIEF_DECAY } from "./types.js";
import { type UpdateOptions, updateBelief } from "./update.js";

/** 信念条目映射。 */
export type BeliefEntryMap = Record<string, { mu: number; sigma2: number; tObs: number }>;

/**
 * 序列化格式。
 *
 * 只包含 entries。fromDict 优雅忽略旧 JSON 中的多余字段
 * （changelog、windows、drifts）——不 throw。
 */
export interface BeliefDict {
  entries: BeliefEntryMap;
}

/** 新信念的默认方差（高不确定性）。 */
const DEFAULT_SIGMA2 = 1.0;

function makeKey(entityId: string, attr: string): string {
  return `${entityId}::${attr}`;
}

export class BeliefStore {
  private beliefs = new Map<string, BeliefTriple>();

  /** ADR-123 D2: 域→衰减参数映射。未注册的域使用 defaultParams。 */
  private domainDecayParams = new Map<string, BeliefDecayParams>();

  get(entityId: string, attr: string): BeliefTriple | undefined {
    return this.beliefs.get(makeKey(entityId, attr));
  }

  set(entityId: string, attr: string, belief: BeliefTriple): void {
    this.beliefs.set(makeKey(entityId, attr), belief);
  }

  /** 获取信念，不存在时返回高不确定性默认值。 */
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
   * 贝叶斯更新方法。
   *
   * F4: `nowMs` 替代 `tick`——tObs 存储墙钟 ms，与 tick 间隔解耦。
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
   * ADR-123 D2: 注册域衰减参数。
   * domainPrefix 例: "trait:", "jargon:", "expression:"
   */
  registerDomainDecay(domainPrefix: string, params: BeliefDecayParams): void {
    this.domainDecayParams.set(domainPrefix, params);
  }

  /**
   * 对所有信念执行时间衰减。
   * F4: 参数从 `tick` 改为 `nowMs`——衰减速率与 tick 间隔解耦。
   * ADR-123 D2: 使用注册的域衰减参数替代硬编码 key.includes("::trait:")。
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
   * 计算信念的 Shannon entropy。
   * H(b) = 0.5 · ln(2πe · σ²)
   * 高斯分布的微分熵。σ² 越大 → H 越高 → 越不确定。
   */
  entropy(entityId: string, attr: string): number {
    const b = this.beliefs.get(makeKey(entityId, attr));
    if (!b) return 0.5 * Math.log(2 * Math.PI * Math.E * DEFAULT_SIGMA2);
    return 0.5 * Math.log(2 * Math.PI * Math.E * b.sigma2);
  }

  /**
   * 获取某个 entity 下指定 attr 前缀的所有信念。
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

  /** 信念条目数。 */
  get size(): number {
    return this.beliefs.size;
  }

  /** 清空。 */
  clear(): void {
    this.beliefs.clear();
  }

  /** 序列化为结构化字典。 */
  toDict(): BeliefDict {
    const entries: BeliefEntryMap = {};
    for (const [key, b] of this.beliefs) {
      entries[key] = { mu: b.mu, sigma2: b.sigma2, tObs: b.tObs };
    }
    return { entries };
  }

  /**
   * 从结构化字典反序列化。
   * 优雅忽略旧 JSON 中的多余字段（changelog、windows、drifts）。
   */
  static fromDict(data: BeliefDict): BeliefStore {
    const store = new BeliefStore();
    for (const [key, entry] of Object.entries(data.entries ?? {})) {
      store.beliefs.set(key, { mu: entry.mu, sigma2: entry.sigma2, tObs: entry.tObs });
    }
    return store;
  }

  /** 从另一个 store 恢复（原地替换）。 */
  restoreFrom(other: BeliefStore): void {
    this.beliefs.clear();
    const dict = other.toDict();
    for (const [key, entry] of Object.entries(dict.entries)) {
      this.beliefs.set(key, { mu: entry.mu, sigma2: entry.sigma2, tObs: entry.tObs });
    }
  }
}
