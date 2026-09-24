/** Tiny dense linear algebra helpers (no external numerical dependency). */

export type Matrix = number[][];

export function zeros(n: number, m: number): Matrix {
  return Array.from({ length: n }, () => new Array<number>(m).fill(0));
}

export function identity(n: number): Matrix {
  const out = zeros(n, n);
  for (let i = 0; i < n; i += 1) {
    const row = out[i];
    if (row) row[i] = 1;
  }
  return out;
}

export function dot(a: readonly number[], b: readonly number[]): number {
  let total = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) total += (a[i] ?? 0) * (b[i] ?? 0);
  return total;
}

export function matVec(A: Matrix, x: readonly number[]): number[] {
  return A.map((row) => dot(row, x));
}

/** Solves A x = b via Gaussian elimination with partial pivoting. Returns null if singular. */
export function solve(A: Matrix, b: readonly number[]): number[] | null {
  const n = A.length;
  const aug: Matrix = A.map((row, i) => [...row, b[i] ?? 0]);
  for (let col = 0; col < n; col += 1) {
    let pivotRow = col;
    let pivotValue = Math.abs(aug[col]?.[col] ?? 0);
    for (let row = col + 1; row < n; row += 1) {
      const value = Math.abs(aug[row]?.[col] ?? 0);
      if (value > pivotValue) {
        pivotValue = value;
        pivotRow = row;
      }
    }
    if (pivotValue < 1e-12) return null;
    const tmp = aug[col];
    aug[col] = aug[pivotRow] as number[];
    aug[pivotRow] = tmp as number[];
    const pivot = aug[col]?.[col] ?? 1;
    const pivotRowValues = aug[col] as number[];
    for (let k = col; k <= n; k += 1) {
      pivotRowValues[k] = (pivotRowValues[k] ?? 0) / pivot;
    }
    for (let row = 0; row < n; row += 1) {
      if (row === col) continue;
      const rowValues = aug[row] as number[];
      const factor = rowValues[col] ?? 0;
      if (factor === 0) continue;
      for (let k = col; k <= n; k += 1) {
        rowValues[k] = (rowValues[k] ?? 0) - factor * (pivotRowValues[k] ?? 0);
      }
    }
  }
  return aug.map((row) => row[n] ?? 0);
}

/** Inverts a symmetric positive-definite matrix; returns null when singular. */
export function invert(A: Matrix): Matrix | null {
  const n = A.length;
  const inverse = zeros(n, n);
  for (let i = 0; i < n; i += 1) {
    const unit = new Array<number>(n).fill(0);
    unit[i] = 1;
    const column = solve(A, unit);
    if (!column) return null;
    for (let row = 0; row < n; row += 1) {
      const target = inverse[row] as number[];
      target[i] = column[row] ?? 0;
    }
  }
  return inverse;
}

/** Cholesky factor L with A = L Lᵀ. Returns null when A is not PD. */
export function cholesky(A: Matrix): Matrix | null {
  const n = A.length;
  const L = zeros(n, n);
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j <= i; j += 1) {
      let sumValue = (A[i]?.[j] ?? 0);
      for (let k = 0; k < j; k += 1) {
        sumValue -= (L[i]?.[k] ?? 0) * (L[j]?.[k] ?? 0);
      }
      if (i === j) {
        if (sumValue <= 1e-12) return null;
        const row = L[i] as number[];
        row[j] = Math.sqrt(sumValue);
      } else {
        const denom = L[j]?.[j] ?? 0;
        if (Math.abs(denom) < 1e-12) return null;
        const row = L[i] as number[];
        row[j] = sumValue / denom;
      }
    }
  }
  return L;
}

export function isFiniteMatrix(A: Matrix): boolean {
  return A.every((row) => row.every((value) => Number.isFinite(value)));
}
