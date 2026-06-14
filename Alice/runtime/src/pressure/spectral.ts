/**
 * Инструмент спектрального анализа — вычисляет значение Фидлера (второе наименьшее собственное значение) Лапласиана графа.
 *
 * Значение Фидлера измеряет алгебраическую связность графа:
 * - λ₂ = 0 → граф несвязен (как минимум две компоненты связности)
 * - λ₂ > 0 → граф связен; чем больше значение, тем сильнее связность
 * - λ₂ ≈ 0 → граф на грани распада (существует бутылочное горло)
 *
 * Для приближения λ₂ используется метод обратной степенной итерации со сдвигом.
 *
 * @see paper/ §4 "Spectral Analysis of the Companion Graph"
 */
import type { WorldModel } from "../graph/world-model.js";
import { type SparseMatrix, sparseMV } from "./propagation.js";

/**
 * Строит невзвешенную матрицу Лапласиана графа L = D - A (разреженный формат CSR).
 * Направление рёбер игнорируется — ориентированный граф рассматривается как неориентированный.
 * Использует интерфейс SparseMatrix из propagation.ts.
 */
function buildLaplacian(G: WorldModel): { L: SparseMatrix; nodeIds: string[] } {
  const nodeIds = G.allNodeIds();
  const n = nodeIds.length;
  const indexMap = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    indexMap.set(nodeIds[i], i);
  }

  // Дедупликация для неориентированного графа + подсчёт степеней
  const seen = new Set<number>(); // кодировка: lo * n + hi
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

  // Собираем триплеты: диагональ D[i]=degree(i) + внедиагональные -1
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

  // Строим CSR
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
 * Строит CSR-матрицу M = λ_max·I - L.
 * Диагональ L = degree, внедиагональ = -1.
 * Диагональ M = λ_max - degree, внедиагональ = 1 (матрица смежности).
 * Изолированные узлы не имеют записей в L — для них нужно добавить диагональный элемент λ_max в M.
 */
function buildShiftedMatrix(L: SparseMatrix, lambdaMax: number): SparseMatrix {
  const n = L.n;

  // Считаем изолированные узлы (строки без записей в L) — им нужен дополнительный диагональный элемент
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
      // Изолированный узел: нулевая строка L → M[i][i] = λ_max
      colIdx[pos] = i;
      values[pos] = lambdaMax;
      pos++;
    } else {
      // Неизолированный узел: диагональ λ_max - L[i][i], внедиагональ -L[i][j]
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
 * L2-норма вектора.
 */
function vecNorm(x: number[]): number {
  let sum = 0;
  for (const v of x) sum += v * v;
  return Math.sqrt(sum);
}

/**
 * Скалярное произведение векторов.
 */
function vecDot(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

/**
 * Удаляет из вектора проекцию на direction (ортогонализация Грама–Шмидта).
 */
function removeProjection(x: number[], direction: number[]): void {
  const dot = vecDot(x, direction);
  for (let i = 0; i < x.length; i++) {
    x[i] -= dot * direction[i];
  }
}

/**
 * Вычисляет приближённое значение Фидлера (второе наименьшее собственное значение) Лапласиана графа.
 *
 * Подход — степенная итерация на L:
 * 1. Наименьшее собственное значение L: λ₁ = 0 (соответствует вектору из единиц)
 * 2. В подпространстве, ортогональном вектору из единиц, степенная итерация
 *    даёт частное Рэлея для наибольшего собственного значения
 * 3. Но нам нужно λ₂ (второе наименьшее), поэтому используется shifted inverse power iteration
 *
 * На практике применяется более простой способ: степенная итерация на L для нахождения λ_max,
 * затем степенная итерация на (λ_max·I - L) для нахождения μ_max,
 * λ₂ = λ_max - μ_max. Для малых графов deflation устойчивее.
 *
 * Упрощённая реализация: для малых графов (≤500 узлов) используется power iteration + deflation.
 *
 * @returns Значение Фидлера (λ₂). Возвращает 0, если число узлов графа ≤ 1.
 */
export function approximateFiedlerValue(G: WorldModel): number {
  const { L } = buildLaplacian(G);
  const n = L.n;

  if (n <= 1) return 0;

  // Нормированный вектор из единиц (собственный вектор для λ₁ = 0)
  const ones = new Array<number>(n).fill(1 / Math.sqrt(n));

  // Степенная итерация на (λ_max·I - L) в подпространстве, ортогональном вектору из единиц, для нахождения максимального собственного значения
  // Сначала находим λ_max (максимальное собственное значение L)
  const maxIter = 200;
  const tol = 1e-10;

  // Step 1: степенная итерация для нахождения λ_max (детерминированная инициализация для воспроизводимости тестов)
  const x = new Array<number>(n);
  for (let i = 0; i < n; i++) x[i] = (i % 2 === 0 ? 1 : -1) / Math.sqrt(n);
  removeProjection(x, ones);
  let norm = vecNorm(x);
  if (norm < tol) return 0; // все узлы эквивалентны
  for (let i = 0; i < n; i++) x[i] /= norm;

  let lambdaMax = 0;
  for (let iter = 0; iter < maxIter; iter++) {
    const y = sparseMV(L, x);
    removeProjection(y, ones);
    const newNorm = vecNorm(y);
    if (newNorm < tol) break;
    const newLambda = vecDot(x, y); // частное Рэлея
    for (let i = 0; i < n; i++) x[i] = y[i] / newNorm;
    if (Math.abs(newLambda - lambdaMax) < tol) {
      lambdaMax = newLambda;
      break;
    }
    lambdaMax = newLambda;
  }

  if (lambdaMax < tol) return 0; // все собственные значения равны 0 (изолированные узлы)

  // Step 2: строим M = λ_max·I - L (CSR) и находим максимальное собственное значение M μ_max в подпространстве, ортогональном вектору из единиц
  // λ₂ = λ_max - μ_max
  const M = buildShiftedMatrix(L, lambdaMax);

  // Степенная итерация на M (детерминированная инициализация: centered ramp, смещение к низкочастотным собственным векторам)
  // Первый запуск — знакочередующийся (высокие частоты), второй — ramp (низкие частоты), чтобы начальный вектор не попал в нулевое пространство M
  const z = new Array<number>(n);
  for (let i = 0; i < n; i++) z[i] = 2 * i - n + 1;
  removeProjection(z, ones);
  norm = vecNorm(z);
  if (norm < tol) return lambdaMax; // только два различных собственных значения
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
  // Числовые ошибки могут давать незначительные отрицательные значения
  return Math.max(0, fiedler);
}
