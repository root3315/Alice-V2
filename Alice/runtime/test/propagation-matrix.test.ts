/**
 * 矩阵 Laplacian 传播 + 谱分析 单元测试。
 *
 * 验证 CSR SpMV 实现与论文公式和旧版邻居遍历实现的数值一致性。
 */
import { describe, expect, it } from "vitest";
import { WorldModel } from "../src/graph/world-model.js";
import {
  buildWeightedAdjacency,
  normalizeRows,
  propagatePressuresMatrix,
  type SparseMatrix,
  sparseMV,
} from "../src/pressure/propagation.js";
import { approximateFiedlerValue } from "../src/pressure/spectral.js";

// -- 辅助函数 ----------------------------------------------------------------

/** 构建简单星形图：center → leaf1, leaf2, leaf3（social 边）。 */
function buildStarGraph(): WorldModel {
  const G = new WorldModel();
  G.tick = 10;
  G.addContact("center", { tier: 5 });
  G.addContact("leaf1", { tier: 50 });
  G.addContact("leaf2", { tier: 50 });
  G.addContact("leaf3", { tier: 50 });
  G.addRelation("center", "friend", "leaf1");
  G.addRelation("center", "friend", "leaf2");
  G.addRelation("center", "friend", "leaf3");
  return G;
}

/** 构建环形图：A → B → C → A（social 边）。 */
function buildRingGraph(): WorldModel {
  const G = new WorldModel();
  G.tick = 10;
  G.addContact("A", { tier: 5 });
  G.addContact("B", { tier: 5 });
  G.addContact("C", { tier: 5 });
  G.addRelation("A", "friend", "B");
  G.addRelation("B", "friend", "C");
  G.addRelation("C", "friend", "A");
  return G;
}

// -- CSR 构造正确性 ----------------------------------------------------------

describe("CSR 构造", () => {
  it("空图：无边时矩阵为零", () => {
    const G = new WorldModel();
    G.addContact("alone", { tier: 150 });
    const { matrix, entityIndex } = buildWeightedAdjacency(G);
    expect(matrix.n).toBe(1);
    expect(matrix.rowPtr).toEqual([0, 0]);
    expect(matrix.colIdx).toEqual([]);
    expect(matrix.values).toEqual([]);
    expect(entityIndex.size).toBe(1);
  });

  it("单边 u→v：A^T[v][u] 有值", () => {
    const G = new WorldModel();
    G.addContact("u", { tier: 50 });
    G.addContact("v", { tier: 50 });
    G.addRelation("u", "friend", "v"); // social, ω = 1.0

    const { matrix, entityIndex } = buildWeightedAdjacency(G);
    expect(matrix.n).toBe(2);

    const idxU = entityIndex.get("u") ?? 0;
    const idxV = entityIndex.get("v") ?? 0;

    // A^T[v][u] = 1.0（social weight）
    // 行 v 应有一个非零元素在列 u
    const vStart = matrix.rowPtr[idxV];
    const vEnd = matrix.rowPtr[idxV + 1];
    expect(vEnd - vStart).toBe(1);
    expect(matrix.colIdx[vStart]).toBe(idxU);
    expect(matrix.values[vStart]).toBeCloseTo(1.0, 6);

    // 行 u 应无非零元素
    const uStart = matrix.rowPtr[idxU];
    const uEnd = matrix.rowPtr[idxU + 1];
    expect(uEnd - uStart).toBe(0);
  });

  it("星形图：CSR 行指针和列索引正确", () => {
    const G = buildStarGraph();
    const { matrix, entityIndex } = buildWeightedAdjacency(G);

    // center → leaf1/2/3，转置后 leaf1/2/3 各有一个入边
    for (const leaf of ["leaf1", "leaf2", "leaf3"]) {
      const idx = entityIndex.get(leaf) ?? 0;
      const start = matrix.rowPtr[idx];
      const end = matrix.rowPtr[idx + 1];
      expect(end - start).toBe(1);
      expect(matrix.colIdx[start]).toBe(entityIndex.get("center") ?? 0);
    }

    // center 无入边（转置中无非零元素在 center 行）
    const centerIdx = entityIndex.get("center") ?? 0;
    expect(matrix.rowPtr[centerIdx + 1] - matrix.rowPtr[centerIdx]).toBe(0);
  });
});

// -- SpMV 正确性 -------------------------------------------------------------

describe("sparseMV", () => {
  it("零矩阵 × 任意向量 = 零向量", () => {
    const A: SparseMatrix = { n: 3, rowPtr: [0, 0, 0, 0], colIdx: [], values: [] };
    const result = sparseMV(A, [1, 2, 3]);
    expect(result).toEqual([0, 0, 0]);
  });

  it("单位矩阵 × 向量 = 向量", () => {
    // 3×3 单位矩阵 CSR
    const A: SparseMatrix = {
      n: 3,
      rowPtr: [0, 1, 2, 3],
      colIdx: [0, 1, 2],
      values: [1, 1, 1],
    };
    const result = sparseMV(A, [3, 5, 7]);
    expect(result).toEqual([3, 5, 7]);
  });

  it("手工矩阵：[[2,0],[1,3]] × [1,2] = [2, 7]", () => {
    const A: SparseMatrix = {
      n: 2,
      rowPtr: [0, 1, 3],
      colIdx: [0, 0, 1],
      values: [2, 1, 3],
    };
    const result = sparseMV(A, [1, 2]);
    expect(result[0]).toBeCloseTo(2, 10);
    expect(result[1]).toBeCloseTo(7, 10);
  });
});

// -- 传播数值正确性 ----------------------------------------------------------

describe("propagatePressuresMatrix", () => {
  it("单节点无边：p_eff = p_local", () => {
    const G = new WorldModel();
    G.addContact("solo", { tier: 150 });
    const local = { solo: 5.0 };
    const result = propagatePressuresMatrix(G, local, 0.3);
    expect(result.solo).toBeCloseTo(5.0, 6);
  });

  it("星形图：中心压力传播到叶子", () => {
    const G = buildStarGraph();
    const local = { center: 10.0, leaf1: 0, leaf2: 0, leaf3: 0 };
    const mu = 0.3;
    const result = propagatePressuresMatrix(G, local, mu);

    // center → leaf_k: social ω=1.0, no decay → 传播量 = mu * 1.0 * 10 = 3.0
    for (const leaf of ["leaf1", "leaf2", "leaf3"]) {
      expect(result[leaf]).toBeCloseTo(0 + 3.0, 6);
    }
    // center 无入边 → 不接收传播
    expect(result.center).toBeCloseTo(10.0, 6);
  });

  it("环形图：对称传播", () => {
    const G = buildRingGraph();
    // 所有节点等压
    const local = { A: 5.0, B: 5.0, C: 5.0 };
    const mu = 0.3;
    const result = propagatePressuresMatrix(G, local, mu);

    // 环: A→B→C→A，每个节点恰好接收一个前驱的传播
    // 传播量 = mu * 1.0 * 5.0 = 1.5
    for (const node of ["A", "B", "C"]) {
      expect(result[node]).toBeCloseTo(5.0 + 1.5, 6);
    }
  });

  it("不在图中的 localPressure 键被保留", () => {
    const G = new WorldModel();
    G.addContact("a", { tier: 50 });
    const local = { a: 1.0, phantom: 99.0 };
    const result = propagatePressuresMatrix(G, local, 0.3);
    expect(result.phantom).toBe(99.0); // 不在图中，原样保留
    expect(result.a).toBeCloseTo(1.0, 6);
  });
});

// -- Per-node susceptibility λ_v ---------------------------------------------

describe("per-node susceptibility λ_v", () => {
  it("self (agent) 节点：传播量为 0", () => {
    const G = new WorldModel();
    G.tick = 10;
    G.addContact("source", { tier: 5 });
    G.addAgent("self", {});
    G.addRelation("source", "knows", "self");

    const local = { source: 10.0, self: 0 };
    const result = propagatePressuresMatrix(G, local, 0.3);

    // agent 类型 λ=0，不接收传播
    expect(result.self).toBeCloseTo(0, 6);
  });

  it("group channel 传播量为 contact 的 0.3 倍", () => {
    const G = new WorldModel();
    G.tick = 10;
    G.addContact("source", { tier: 5 });
    G.addContact("target_contact", { tier: 50 });
    G.addChannel("target_group", { chat_type: "group" });
    // 使用相同标签（同一 ω 权重）隔离 susceptibility 效果
    G.addRelation("source", "friend", "target_contact");
    G.addRelation("source", "friend", "target_group");

    const local = { source: 10.0, target_contact: 0, target_group: 0 };
    const result = propagatePressuresMatrix(G, local, 0.3);

    // contact λ=1.0: 传播 = 1.0 × 0.3 × 10 = 3.0
    // group channel λ=0.3: 传播 = 0.3 × 0.3 × 10 = 0.9
    expect(result.target_contact).toBeCloseTo(3.0, 6);
    expect(result.target_group).toBeCloseTo(0.9, 6);
    expect(result.target_group / result.target_contact).toBeCloseTo(0.3, 4);
  });

  it("private channel：λ=0.6", () => {
    const G = new WorldModel();
    G.tick = 10;
    G.addContact("source", { tier: 5 });
    G.addChannel("priv_ch", { chat_type: "private" });
    G.addRelation("source", "friend", "priv_ch");

    const local = { source: 10.0, priv_ch: 0 };
    const result = propagatePressuresMatrix(G, local, 0.3);

    // private channel λ=0.6: 传播 = 0.6 × 0.3 × 10 = 1.8
    expect(result.priv_ch).toBeCloseTo(1.8, 6);
  });

  it("不传 config：默认 contact λ=1.0 行为不变", () => {
    const G = buildStarGraph();
    const local = { center: 10.0, leaf1: 0, leaf2: 0, leaf3: 0 };
    const result = propagatePressuresMatrix(G, local, 0.3);

    // 所有节点都是 contact，λ=1.0，与旧行为一致
    for (const leaf of ["leaf1", "leaf2", "leaf3"]) {
      expect(result[leaf]).toBeCloseTo(3.0, 6);
    }
  });

  it("自定义 susceptibility 生效", () => {
    const G = new WorldModel();
    G.tick = 10;
    G.addContact("source", { tier: 5 });
    G.addContact("target", { tier: 50 });
    G.addRelation("source", "friend", "target");

    const local = { source: 10.0, target: 0 };
    const config = { susceptibility: { contact: 0.5 } };
    const result = propagatePressuresMatrix(G, local, 0.3, 0, config);

    // 自定义 contact λ=0.5: 传播 = 0.5 × 0.3 × 10 = 1.5
    expect(result.target).toBeCloseTo(1.5, 6);
  });

  it("supergroup channel 与 group 使用相同 λ=0.3", () => {
    const G = new WorldModel();
    G.tick = 10;
    G.addContact("source", { tier: 5 });
    G.addChannel("sg", { chat_type: "supergroup" });
    G.addRelation("source", "friend", "sg");

    const local = { source: 10.0, sg: 0 };
    const result = propagatePressuresMatrix(G, local, 0.3);

    // supergroup λ=0.3: 传播 = 0.3 × 0.3 × 10 = 0.9
    expect(result.sg).toBeCloseTo(0.9, 6);
  });
});

// -- Fiedler value 谱分析 ----------------------------------------------------

describe("approximateFiedlerValue", () => {
  it("单节点：Fiedler = 0", () => {
    const G = new WorldModel();
    G.addContact("solo", { tier: 150 });
    expect(approximateFiedlerValue(G)).toBe(0);
  });

  it("两个孤立节点（无边）：Fiedler = 0（不连通）", () => {
    const G = new WorldModel();
    G.addContact("a", { tier: 50 });
    G.addContact("b", { tier: 50 });
    expect(approximateFiedlerValue(G)).toBeCloseTo(0, 4);
  });

  it("两个连通节点：Fiedler = 2", () => {
    const G = new WorldModel();
    G.addContact("a", { tier: 50 });
    G.addContact("b", { tier: 50 });
    G.addRelation("a", "friend", "b");
    // K2 的 Laplacian 特征值: 0, 2
    expect(approximateFiedlerValue(G)).toBeCloseTo(2, 2);
  });

  it("三角形（K3）：Fiedler = 3", () => {
    // 完全图 K3 的 Laplacian 特征值: 0, 3, 3
    const G = new WorldModel();
    G.addContact("a", { tier: 50 });
    G.addContact("b", { tier: 50 });
    G.addContact("c", { tier: 50 });
    G.addRelation("a", "friend", "b");
    G.addRelation("b", "friend", "c");
    G.addRelation("a", "friend", "c");
    expect(approximateFiedlerValue(G)).toBeCloseTo(3, 1);
  });

  it("路径图 P3 (A-B-C)：Fiedler = 1", () => {
    // P3 的 Laplacian 特征值: 0, 1, 3
    const G = new WorldModel();
    G.addContact("a", { tier: 50 });
    G.addContact("b", { tier: 50 });
    G.addContact("c", { tier: 50 });
    G.addRelation("a", "friend", "b");
    G.addRelation("b", "friend", "c");
    expect(approximateFiedlerValue(G)).toBeCloseTo(1, 1);
  });

  it("星形图 S3：Fiedler = 1", () => {
    // S3（center + 3 叶）的 Laplacian 特征值: 0, 1, 1, 4
    // λ₂ = 1
    const G = buildStarGraph();
    expect(approximateFiedlerValue(G)).toBeCloseTo(1, 1);
  });

  it("Fiedler value 非负", () => {
    const G = buildRingGraph();
    expect(approximateFiedlerValue(G)).toBeGreaterThanOrEqual(0);
  });
});

// -- normalizeRows 行归一化 ---------------------------------------------------

describe("normalizeRows", () => {
  it("单行矩阵归一化：行和为 1", () => {
    const A: SparseMatrix = {
      n: 2,
      rowPtr: [0, 2, 2],
      colIdx: [0, 1],
      values: [3, 7],
    };
    const norm = normalizeRows(A);
    expect(norm.values[0]).toBeCloseTo(0.3, 10);
    expect(norm.values[1]).toBeCloseTo(0.7, 10);
  });

  it("空行保持零", () => {
    const A: SparseMatrix = {
      n: 2,
      rowPtr: [0, 0, 2],
      colIdx: [0, 1],
      values: [4, 6],
    };
    const norm = normalizeRows(A);
    // 行 0 空，行 1 归一化
    expect(norm.values[0]).toBeCloseTo(0.4, 10);
    expect(norm.values[1]).toBeCloseTo(0.6, 10);
  });

  it("不修改原矩阵", () => {
    const A: SparseMatrix = {
      n: 1,
      rowPtr: [0, 2],
      colIdx: [0, 0],
      values: [2, 8],
    };
    const origValues = [...A.values];
    normalizeRows(A);
    expect(A.values).toEqual(origValues);
  });
});

// -- APPNP K-step teleport 传播 -----------------------------------------------

describe("APPNP 传播", () => {
  it("K=1 alpha=0：接近 one-hop（单入边时数值一致）", () => {
    // 星形图：每个 leaf 只有一个入边，行归一化不改变权重
    const G = buildStarGraph();
    const local = { center: 10.0, leaf1: 0, leaf2: 0, leaf3: 0 };
    const mu = 0.3;

    const resultOld = propagatePressuresMatrix(G, local, mu);
    const resultAPPNP = propagatePressuresMatrix(G, local, mu, 0, { K: 1, alpha: 0 });

    // 单入边场景：APPNP K=1 alpha=0 与 one-hop 等价
    // p^(1)[leaf] = A_norm * p[center] = 1.0 * 10.0 = 10.0
    // delta = 10.0 - 0 = 10.0
    // p_eff[leaf] = 0 + lambda * mu * 10.0 = 1.0 * 0.3 * 10.0 = 3.0
    for (const leaf of ["leaf1", "leaf2", "leaf3"]) {
      expect(resultAPPNP[leaf]).toBeCloseTo(resultOld[leaf], 4);
    }
  });

  it("K=3：多跳传播覆盖——环形图压力传播更远", () => {
    // 环形图 A→B→C→A，只有 A 有压力
    const G = buildRingGraph();
    const local = { A: 10.0, B: 0, C: 0 };
    const mu = 1.0; // mu=1 放大效果

    // Legacy one-hop: 只有 B 接收（A→B 直接传播）
    const oneHop = propagatePressuresMatrix(G, local, mu);
    expect(oneHop.B).toBeGreaterThan(0);
    // C 无直接从 A 的入边（A→B→C 需要两跳）
    expect(oneHop.C).toBeCloseTo(0, 6);

    // APPNP K=3: C 也收到传播（经 B 中继）
    const appnp = propagatePressuresMatrix(G, local, mu, 0, { K: 3, alpha: 0.15 });
    expect(appnp.B).toBeGreaterThan(0);
    expect(appnp.C).toBeGreaterThan(0); // 多跳覆盖
  });

  it("alpha=1：完全 teleport → 无传播效果", () => {
    const G = buildStarGraph();
    const local = { center: 10.0, leaf1: 0, leaf2: 0, leaf3: 0 };
    const mu = 0.3;

    // alpha=1: p^(k) = 0 * A_norm * p^(k-1) + 1 * p_local = p_local
    // delta = 0 → p_eff = p_local
    const result = propagatePressuresMatrix(G, local, mu, 0, { K: 3, alpha: 1.0 });
    for (const leaf of ["leaf1", "leaf2", "leaf3"]) {
      expect(result[leaf]).toBeCloseTo(0, 10);
    }
    expect(result.center).toBeCloseTo(10.0, 10);
  });

  it("K=3 alpha=0.15：收敛到稳态（迭代稳定）", () => {
    const G = buildRingGraph();
    const local = { A: 5.0, B: 5.0, C: 5.0 };
    const mu = 0.3;

    // 等压 + 对称图 → APPNP 应保持等压
    const result = propagatePressuresMatrix(G, local, mu, 0, { K: 3, alpha: 0.15 });
    // 所有节点压力应相等（对称性）
    expect(result.A).toBeCloseTo(result.B, 4);
    expect(result.B).toBeCloseTo(result.C, 4);
  });

  it("susceptibility 在 APPNP 模式下仍然生效", () => {
    const G = new WorldModel();
    G.tick = 10;
    G.addContact("source", { tier: 5 });
    G.addAgent("self", {});
    G.addRelation("source", "knows", "self");

    const local = { source: 10.0, self: 0 };
    const result = propagatePressuresMatrix(G, local, 0.3, 0, { K: 3, alpha: 0.15 });

    // agent λ=0 → 不接收传播
    expect(result.self).toBeCloseTo(0, 6);
  });

  it("无边时 APPNP 不改变值", () => {
    const G = new WorldModel();
    G.addContact("a", { tier: 50 });
    G.addContact("b", { tier: 50 });

    const local = { a: 5.0, b: 3.0 };
    const result = propagatePressuresMatrix(G, local, 0.3, 0, { K: 3, alpha: 0.15 });
    expect(result.a).toBeCloseTo(5.0, 10);
    expect(result.b).toBeCloseTo(3.0, 10);
  });

  it("K 增大时收敛（K=10 与 K=3 差异小）", () => {
    const G = buildStarGraph();
    const local = { center: 10.0, leaf1: 0, leaf2: 2.0, leaf3: 0 };
    const mu = 0.3;
    const alpha = 0.15;

    const r3 = propagatePressuresMatrix(G, local, mu, 0, { K: 3, alpha });
    const r10 = propagatePressuresMatrix(G, local, mu, 0, { K: 10, alpha });

    // 更多迭代应收敛，差异很小
    for (const leaf of ["leaf1", "leaf2", "leaf3"]) {
      expect(Math.abs(r10[leaf] - r3[leaf])).toBeLessThan(0.5);
    }
  });
});
