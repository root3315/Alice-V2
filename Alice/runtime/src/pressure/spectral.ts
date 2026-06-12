/**
 * 谱分析工具——计算图 Laplacian 的 Fiedler value（第二小特征值）。
 *
 * Fiedler value 衡量图的代数连通性：
 * - λ₂ = 0 → 图不连通（至少两个连通分量）
 * - λ₂ > 0 → 图连通，值越大连通性越强
 * - λ₂ ≈ 0 → 图即将断裂（存在瓶颈边）
 *
 * 使用 Inverse Power Iteration with shift 逼近 λ₂。
 *
 * @see paper/ §4 "Spectral Analysis of the Companion Graph"
 */
import type { WorldModel } from "../graph/world-model.js";
import { type SparseMatrix, sparseMV } from "./propagation.js";

/**
 * 构建图的无权 Laplacian 矩阵 L = D - A（CSR 稀疏格式）。
 * 忽略边方向，将有向图视为无向图处理。
 * 复用 propagation.ts 的 SparseMatrix 接口。
 */
function buildLaplacian(G: WorldModel): { L: SparseMatrix; nodeIds: string[] } {
  const nodeIds = G.allNodeIds();
  const n = nodeIds.length;
  const indexMap = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    indexMap.set(nodeIds[i], i);
  }

  // 无向化去重 + 度数统计
  const seen = new Set<number>(); // 编码: lo * n + hi
  const degree = new Array<number>(n).fill(0);
  const offDiag: Array<[number, number]> = []; // [row, col]

  for (const [u, v] of G.allEdges()) {
    const i = indexMap.get(u);
    const j = indexMap.get(v);
    if (i === undefined || j === undefined || i === j) continue;

    const lo = Math.min(i, j);
    const hi = Math.max(i, j);
    const key = lo * n + hi;
    if (seen.has(key)) continue;
    seen.add(key);

    degree[i]++;
    degree[j]++;
    offDiag.push([i, j]);
    offDiag.push([j, i]);
  }

  // 收集 triplets：对角线 D[i]=degree(i) + 非对角线 -1
  const triplets: Array<{ row: number; col: number; value: number }> = [];
  for (let i = 0; i < n; i++) {
    if (degree[i] > 0) {
      triplets.push({ row: i, col: i, value: degree[i] });
    }
  }
  for (const [row, col] of offDiag) {
    triplets.push({ row, col, value: -1 });
  }

  triplets.sort((a, b) => a.row - b.row || a.col - b.col);

  // 构建 CSR
  const rowPtr = new Array<number>(n + 1).fill(0);
  const colIdx: number[] = [];
  const values: number[] = [];

  for (const t of triplets) {
    colIdx.push(t.col);
    values.push(t.value);
    rowPtr[t.row + 1]++;
  }
  for (let i = 1; i <= n; i++) {
    rowPtr[i] += rowPtr[i - 1];
  }

  return { L: { n, rowPtr, colIdx, values }, nodeIds };
}

/**
 * 构建 M = λ_max·I - L 的 CSR 矩阵。
 * L 的对角线 = degree，非对角线 = -1。
 * M 的对角线 = λ_max - degree，非对角线 = 1（邻接矩阵）。
 * 孤立节点在 L 中无条目，M 中需要补上 λ_max 对角线。
 */
function buildShiftedMatrix(L: SparseMatrix, lambdaMax: number): SparseMatrix {
  const n = L.n;

  // 统计孤立节点（L 中无条目的行），它们需要补一个对角线条目
  let emptyRows = 0;
  for (let i = 0; i < n; i++) {
    if (L.rowPtr[i] === L.rowPtr[i + 1]) emptyRows++;
  }

  const totalNnz = L.values.length + emptyRows;
  const rowPtr = new Array<number>(n + 1);
  const colIdx = new Array<number>(totalNnz);
  const values = new Array<number>(totalNnz);

  rowPtr[0] = 0;
  let pos = 0;

  for (let i = 0; i < n; i++) {
    const start = L.rowPtr[i];
    const end = L.rowPtr[i + 1];

    if (start === end) {
      // 孤立节点：L 全零行 → M[i][i] = λ_max
      colIdx[pos] = i;
      values[pos] = lambdaMax;
      pos++;
    } else {
      // 非孤立节点：对角线 λ_max - L[i][i]，非对角线 -L[i][j]
      for (let j = start; j < end; j++) {
        colIdx[pos] = L.colIdx[j];
        values[pos] = L.colIdx[j] === i ? lambdaMax - L.values[j] : -L.values[j];
        pos++;
      }
    }

    rowPtr[i + 1] = pos;
  }

  return { n, rowPtr, colIdx, values };
}

/**
 * 向量 L2 范数。
 */
function vecNorm(x: number[]): number {
  let sum = 0;
  for (const v of x) sum += v * v;
  return Math.sqrt(sum);
}

/**
 * 向量点积。
 */
function vecDot(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

/**
 * 从向量中移除沿 direction 的分量（Gram-Schmidt 正交化）。
 */
function removeProjection(x: number[], direction: number[]): void {
  const dot = vecDot(x, direction);
  for (let i = 0; i < x.length; i++) {
    x[i] -= dot * direction[i];
  }
}

/**
 * 计算图 Laplacian 的 Fiedler value（第二小特征值）的近似值。
 *
 * 使用 Power Iteration on L 的方法：
 * 1. L 的最小特征值 λ₁ = 0（对应全 1 向量）
 * 2. 在正交于全 1 向量的子空间中做 power iteration
 *    得到最大特征值对应的 Rayleigh quotient
 * 3. 但我们要 λ₂（第二小），所以用 shifted inverse power iteration
 *
 * 实际采用更简单的方法：直接在 L 上做 power iteration 求最大特征值 λ_max，
 * 然后在 (λ_max·I - L) 上做 power iteration 求其最大特征值 μ_max，
 * λ₂ = λ_max - μ_max。但对小图我们直接用 deflation 更稳定。
 *
 * 简化实现：对小图（≤500 节点）使用 power iteration + deflation。
 *
 * @returns Fiedler value (λ₂)。图节点数 ≤ 1 时返回 0。
 */
export function approximateFiedlerValue(G: WorldModel): number {
  const { L } = buildLaplacian(G);
  const n = L.n;

  if (n <= 1) return 0;

  // 全 1 向量归一化（λ₁ = 0 的特征向量）
  const ones = new Array<number>(n).fill(1 / Math.sqrt(n));

  // 使用 power iteration on (λ_max·I - L) 在正交于全 1 的子空间中求最大特征值
  // 先求 λ_max (L 的最大特征值)
  const maxIter = 200;
  const tol = 1e-10;

  // Step 1: Power iteration 求 λ_max（确定性初始化，保证测试可重现）
  const x = new Array<number>(n);
  for (let i = 0; i < n; i++) x[i] = (i % 2 === 0 ? 1 : -1) / Math.sqrt(n);
  removeProjection(x, ones);
  let norm = vecNorm(x);
  if (norm < tol) return 0; // 所有节点等价
  for (let i = 0; i < n; i++) x[i] /= norm;

  let lambdaMax = 0;
  for (let iter = 0; iter < maxIter; iter++) {
    const y = sparseMV(L, x);
    removeProjection(y, ones);
    const newNorm = vecNorm(y);
    if (newNorm < tol) break;
    const newLambda = vecDot(x, y); // Rayleigh quotient
    for (let i = 0; i < n; i++) x[i] = y[i] / newNorm;
    if (Math.abs(newLambda - lambdaMax) < tol) {
      lambdaMax = newLambda;
      break;
    }
    lambdaMax = newLambda;
  }

  if (lambdaMax < tol) return 0; // 所有特征值为 0（孤立节点）

  // Step 2: 构建 M = λ_max·I - L（CSR），在正交于全 1 的子空间中求 M 的最大特征值 μ_max
  // λ₂ = λ_max - μ_max
  const M = buildShiftedMatrix(L, lambdaMax);

  // Power iteration on M（确定性初始化：centered ramp，偏向低频特征向量）
  // 第一次用交替符号（高频），第二次用 ramp（低频），避免初始向量落入 M 的零空间
  const z = new Array<number>(n);
  for (let i = 0; i < n; i++) z[i] = 2 * i - n + 1;
  removeProjection(z, ones);
  norm = vecNorm(z);
  if (norm < tol) return lambdaMax; // 只有两个不同特征值
  for (let i = 0; i < n; i++) z[i] /= norm;

  let muMax = 0;
  for (let iter = 0; iter < maxIter; iter++) {
    const y = sparseMV(M, z);
    removeProjection(y, ones);
    const newNorm = vecNorm(y);
    if (newNorm < tol) break;
    const newMu = vecDot(z, y);
    for (let i = 0; i < n; i++) z[i] = y[i] / newNorm;
    if (Math.abs(newMu - muMax) < tol) {
      muMax = newMu;
      break;
    }
    muMax = newMu;
  }

  const fiedler = lambdaMax - muMax;
  // 数值误差可能导致微小负值
  return Math.max(0, fiedler);
}
