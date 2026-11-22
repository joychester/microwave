// A traffic source's request path mix: "path:percent" pairs, comma separated, e.g. "/orders:30,/products:70".
// The engine only needs the relative weights; the editor and the run check want the shares to add up to 100%.

export interface MixRow { path: string; pct: string }

/** Splits the stored text into rows, keeping what was typed (an empty or half-typed share stays as is). */
export function parseMix(raw: string): MixRow[] {
  const rows = String(raw ?? '').split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const i = s.lastIndexOf(':');
    return i < 0 ? { path: s, pct: '' } : { path: s.slice(0, i).trim(), pct: s.slice(i + 1).trim() };
  });
  return rows.length ? rows : [{ path: '/', pct: '100' }];
}

/** Rows back to the stored text. */
export function formatMix(rows: MixRow[]): string {
  return rows.map((r) => `${r.path.trim()}:${r.pct.trim()}`).join(',');
}

const round1 = (x: number) => Math.round(x * 10) / 10;

/** The shares' total, to one decimal; NaN if a share isn't a number. */
export function mixTotal(rows: MixRow[]): number {
  let t = 0;
  for (const r of rows) {
    const v = Number(r.pct);
    if (r.pct.trim() === '' || !isFinite(v)) return NaN;
    t += v;
  }
  return round1(t);
}

export type MixProblem =
  | { kind: 'path'; row: number }      // empty, or doesn't start with "/"
  | { kind: 'dup'; row: number }       // same path twice
  | { kind: 'pct'; row: number }       // not a number, or not above 0
  | { kind: 'total'; total: number };  // shares don't add up to 100%

/** Everything wrong with a mix, first per row, then the total. Empty when it can run. */
export function mixProblems(rows: MixRow[]): MixProblem[] {
  const out: MixProblem[] = [];
  const seen = new Set<string>();
  rows.forEach((r, i) => {
    const p = r.path.trim();
    if (!p.startsWith('/')) out.push({ kind: 'path', row: i });
    else if (seen.has(p)) out.push({ kind: 'dup', row: i });
    seen.add(p);
    const v = Number(r.pct);
    if (r.pct.trim() === '' || !isFinite(v) || v <= 0) out.push({ kind: 'pct', row: i });
  });
  const total = mixTotal(rows);
  if (!out.some((x) => x.kind === 'pct') && total !== 100) out.push({ kind: 'total', total });
  return out;
}

/**
 * Turns relative weights from older topologies ("/:1", "/orders:0.3,/products:0.7", "/a:2,/b:1") into
 * percentages that add up to exactly 100, one decimal at most. The engine normalizes weights, so the
 * traffic it sends is the same. A mix that already adds up to 100, or can't be read, is left alone.
 */
export function mixToPercent(raw: string): string {
  const rows = parseMix(raw);
  const ws = rows.map((r) => Number(r.pct === '' ? 1 : r.pct));
  if (ws.some((w) => !isFinite(w) || w < 0)) return raw;
  const total = ws.reduce((s, w) => s + w, 0);
  if (total <= 0 || round1(total) === 100) return raw;
  const pcts = ws.map((w) => round1((w / total) * 100));
  // put the rounding remainder on the largest share
  const big = pcts.indexOf(Math.max(...pcts));
  pcts[big] = round1(pcts[big] + 100 - pcts.reduce((s, x) => s + x, 0));
  return formatMix(rows.map((r, i) => ({ path: r.path || '/', pct: String(pcts[i]) })));
}
