#!/usr/bin/env tsx
/**
 * 重新生成 cross-validation 黄金值。
 *
 * 用法：
 *   cd runtime && npx tsx scripts/regenerate-golden.ts
 *
 * 输出：test/golden-pressures.json
 *
 * 何时需要重新生成：
 * - 压力公式变更（P1-P6、P_prospect）
 * - 时间量纲迁移（tick → ms）
 * - Laplacian 传播权重变更
 * - 配置默认值变更
 *
 * @see test/cross-validation.test.ts — 消费此文件
 */
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { WorldModel } from "../src/graph/world-model.js";
import { computeAllPressures } from "../src/pressure/aggregate.js";
import { p1AttentionDebt } from "../src/pressure/p1-attention.js";
import { p2InformationPressure } from "../src/pressure/p2-information.js";
import { p3RelationshipCooling } from "../src/pressure/p3-relationship.js";
import { p4ThreadDivergence } from "../src/pressure/p4-thread.js";
import { p5ResponseObligation } from "../src/pressure/p5-response.js";
import { p6Curiosity } from "../src/pressure/p6-curiosity.js";
import { propagatePressuresMatrix as propagatePressures } from "../src/pressure/propagation.js";

// -- 常量 -------------------------------------------------------------------

const TICK = 100;

/** 测试用 tick→ms 转换（约定：1 tick = 60s）。 */
function tickMs(tick: number): number {
  return tick * 60_000;
}

const NOW_MS = tickMs(TICK);

// -- 参数（TypeScript 原生单位：秒/per-second）------------------------------

const PARAMS = {
  thread_age_scale: 86_400, // 秒（= 1 天）
  d: -0.5,
  // ADR-111: beta_sigmoid 已被 P3_BETA_R 常量取代（不再作为外部参数）
  mu: 0.3,
  delta_deadline: 1.0,
  kappa: [5.0, 8.0, 8.0, 5.0, 3.0, 5.0] as [number, number, number, number, number, number],
  k_steepness: 5.0,
  kappa_prospect: 3.0,
};

// -- 图构造（与 cross-validation.test.ts buildGoldenGraph 完全一致）-----------

/** 与 cross-validation.test.ts buildGoldenGraph() 完全一致。 */
function buildGoldenGraph(): WorldModel {
  const G = new WorldModel();
  G.tick = TICK;

  G.addAgent("self");

  G.addContact("alice", { tier: 5, last_active_ms: tickMs(95) });
  G.addContact("bob", { tier: 50, last_active_ms: tickMs(60) });
  G.addContact("carol", { tier: 150, last_active_ms: tickMs(1) });

  G.addChannel("channel:alice", {
    unread: 5,
    tier_contact: 5,
    chat_type: "private",
    pending_directed: 2,
    last_directed_ms: tickMs(98),
    last_incoming_ms: tickMs(100),
  });
  G.addChannel("channel:group", {
    unread: 10,
    tier_contact: 150,
    chat_type: "group",
    pending_directed: 0,
    last_incoming_ms: tickMs(100),
  });
  G.addChannel("channel:empty", {
    unread: 0,
    tier_contact: 50,
    chat_type: "private",
  });

  G.addThread("t_urgent", {
    weight: "major",
    status: "open",
    created_ms: tickMs(90),
    deadline: 110,
    deadline_ms: tickMs(110), // ADR-166: readNodeMs 需要显式 _ms 属性
  });
  G.addThread("t_minor", {
    weight: "minor",
    status: "open",
    created_ms: tickMs(50),
    deadline: Infinity,
  });
  G.addThread("t_done", {
    weight: "minor",
    status: "resolved",
    created_ms: tickMs(10),
  });

  G.addFact("i1", {
    importance: 0.8,
    stability: 2.0,
    last_access_ms: tickMs(90),
    volatility: 0.3,
    tracked: true,
    created_ms: tickMs(80),
    novelty: 0.7,
    fact_type: "observation",
  });
  G.addFact("i2", {
    importance: 0.5,
    stability: 1.0,
    last_access_ms: tickMs(50),
    volatility: 0.1,
    tracked: false,
    created_ms: tickMs(30),
    novelty: 0.2,
    fact_type: "observation",
  });

  G.addRelation("self", "friend", "alice");
  G.addRelation("self", "acquaintance", "bob");
  G.addRelation("self", "stranger", "carol");
  G.addRelation("self", "monitors", "channel:alice");
  G.addRelation("self", "monitors", "channel:group");
  G.addRelation("alice", "joined", "channel:alice");
  G.addRelation("bob", "joined", "channel:group");
  G.addRelation("t_urgent", "involves", "alice");
  G.addRelation("i1", "from", "channel:alice");

  return G;
}

// -- 计算 -------------------------------------------------------------------

function computeGolden() {
  const G = buildGoldenGraph();
  const p = PARAMS;

  // 完整管线
  const result = computeAllPressures(G, TICK, {
    kappa: p.kappa,
    threadAgeScale: p.thread_age_scale,
    mu: p.mu,
    d: p.d,

    deltaDeadline: p.delta_deadline,
    kSteepness: p.k_steepness,
    kappaProspect: p.kappa_prospect,
    nowMs: NOW_MS,
  });

  // 本地压力（预传播）——需要单独调用各 p 函数
  const r1 = p1AttentionDebt(G, NOW_MS);
  const r2 = p2InformationPressure(G, TICK, NOW_MS, p.d);
  const r3 = p3RelationshipCooling(G, TICK, NOW_MS);
  const r4 = p4ThreadDivergence(G, TICK, NOW_MS, p.thread_age_scale, p.delta_deadline);
  const r5 = p5ResponseObligation(G, TICK, NOW_MS);
  const r6 = p6Curiosity(G, NOW_MS);

  const localContributions: Record<string, Record<string, number>> = {
    P1: r1.contributions,
    P2: r2.contributions,
    P3: r3.contributions,
    P4: r4.contributions,
    P5: r5.contributions,
    P6: r6.contributions,
  };

  // 传播
  const localAll: Record<string, number> = {};
  for (const pk of ["P1", "P2", "P3", "P4", "P5", "P6"] as const) {
    for (const [eid, val] of Object.entries(localContributions[pk])) {
      localAll[eid] = (localAll[eid] ?? 0) + val;
    }
  }
  const pEff = propagatePressures(G, localAll, p.mu, TICK, NOW_MS);

  // Wave 5 场景
  const Gw5ar = buildGoldenGraph();
  Gw5ar.setDynamic("channel:group", "activity_relevance", 0.5);
  const w5ar = p1AttentionDebt(Gw5ar, NOW_MS);

  const Gw5ci = buildGoldenGraph();
  Gw5ci.setDynamic("channel:alice", "last_alice_action_ms", tickMs(98));
  const w5ci = p5ResponseObligation(Gw5ci, TICK, NOW_MS);

  return {
    params: p,
    n: TICK,
    pressures: {
      P1: result.P1,
      P2: result.P2,
      P3: result.P3,
      P4: result.P4,
      P5: result.P5,
      P6: result.P6,
      P_prospect: result.P_prospect,
      API: result.API,
    },
    contributions: result.contributions,
    local_contributions: localContributions,
    propagation: {
      local_all: localAll,
      p_eff: pEff,
    },
    wave5: {
      activity_relevance: {
        P1_total: w5ar.total,
        "P1_channel:group": w5ar.contributions["channel:group"],
      },
      conversation_inertia: {
        P5_total: w5ci.total,
        "P5_channel:alice": w5ci.contributions["channel:alice"],
      },
    },
  };
}

// -- 主函数 -----------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(__dirname, "../test/golden-pressures.json");

const golden = computeGolden();
const json = JSON.stringify(golden, null, 2);

writeFileSync(outPath, `${json}\n`);

console.log(`✓ 已写入 ${outPath}`);
console.log(`  P1=${golden.pressures.P1.toFixed(4)}`);
console.log(`  P2=${golden.pressures.P2.toFixed(4)}`);
console.log(`  P3=${golden.pressures.P3.toFixed(4)}`);
console.log(`  P4=${golden.pressures.P4.toFixed(4)}`);
console.log(`  P5=${golden.pressures.P5.toFixed(4)}`);
console.log(`  P6=${golden.pressures.P6.toFixed(4)}`);
console.log(`  P_prospect=${golden.pressures.P_prospect.toFixed(4)}`);
console.log(`  API=${golden.pressures.API.toFixed(4)}`);
