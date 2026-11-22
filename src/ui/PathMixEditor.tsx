import { useEffect, useRef, useState } from 'react';
import { formatMix, mixProblems, mixTotal, parseMix, type MixRow } from '../engine/pathmix';
import { useT } from './i18n';

// The traffic source's request path mix as rows: a path, its share in %, and a × to remove it,
// with "Add path" below and the running total. The shares must add up to 100% before a run starts
// (store.canRun), so the total turns red with what's missing or extra.

export function PathMixEditor({ value, onChange, labelId, disabled }: { value: string; onChange: (v: string) => void; labelId: string; disabled?: boolean }) {
  const t = useT();
  const [rows, setRows] = useState<MixRow[]>(() => parseMix(value));
  const focusRow = useRef<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // follow outside changes (another component loaded, Undo, a lesson) without fighting the typing
  useEffect(() => {
    if (value !== formatMix(rows)) setRows(parseMix(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  useEffect(() => {
    if (focusRow.current === null) return;
    const el = listRef.current?.querySelectorAll<HTMLInputElement>('.pmix-path')[focusRow.current];
    focusRow.current = null;
    el?.focus();
  });

  const commit = (next: MixRow[]) => { setRows(next); onChange(formatMix(next)); };
  const edit = (i: number, p: Partial<MixRow>) => commit(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const remove = (i: number) => commit(rows.filter((_, j) => j !== i));
  const add = () => {
    const total = mixTotal(rows);
    const left = isFinite(total) && total < 100 ? Math.round((100 - total) * 10) / 10 : '';
    focusRow.current = rows.length;
    commit([...rows, { path: '', pct: String(left) }]);
  };

  const problems = mixProblems(rows);
  const bad = (kind: 'path' | 'pct', i: number) => problems.some((p) => (p.kind === kind || (kind === 'path' && p.kind === 'dup')) && 'row' in p && p.row === i);
  const total = mixTotal(rows);
  const totalProblem = problems.find((p) => p.kind === 'total');
  const rowMsgs = problems.flatMap((p) => {
    if (p.kind === 'path') return [rows[p.row].path.trim() ? t(`第 ${p.row + 1} 行：路径须以 / 开头`, `Row ${p.row + 1}: the path must start with /`) : t(`第 ${p.row + 1} 行：请填写路径`, `Row ${p.row + 1}: enter a path`)];
    if (p.kind === 'dup') return [t(`第 ${p.row + 1} 行：路径和前面重复`, `Row ${p.row + 1}: this path is already listed`)];
    if (p.kind === 'pct') return [t(`第 ${p.row + 1} 行：比例须为大于 0 的数字`, `Row ${p.row + 1}: the share must be a number above 0`)];
    return [];
  });
  const fmt = (x: number) => String(Math.round(x * 10) / 10);

  return (
    <div className="pmix" ref={listRef} role="group" aria-labelledby={labelId}>
      <div className="pmix-head" aria-hidden="true">
        <span>{t('路径', 'Path')}</span>
        <span>{t('比例', 'Share')}</span>
      </div>
      {rows.map((r, i) => (
        <div key={i} className="pmix-row">
          <input
            className={`text pmix-path${bad('path', i) ? ' is-bad' : ''}`}
            value={r.path}
            disabled={disabled}
            spellCheck={false}
            placeholder="/orders"
            aria-label={t(`第 ${i + 1} 行路径`, `Path, row ${i + 1}`)}
            aria-invalid={bad('path', i)}
            onChange={(e) => edit(i, { path: e.target.value.replace(/[,:\s]/g, '') })}
            // "orders" means "/orders": add the slash when leaving the field
            onBlur={() => { if (r.path && !r.path.startsWith('/')) edit(i, { path: `/${r.path}` }); }}
          />
          <span className={`num pmix-pct${bad('pct', i) ? ' is-bad' : ''}`}>
            <input
              inputMode="decimal"
              value={r.pct}
              disabled={disabled}
              aria-label={t(`第 ${i + 1} 行比例（%）`, `Share, row ${i + 1} (%)`)}
              aria-invalid={bad('pct', i)}
              onChange={(e) => edit(i, { pct: e.target.value.replace(/[^\d.]/g, '') })}
            />
            <span className="num-unit">%</span>
          </span>
          <button
            type="button"
            className="pmix-del"
            disabled={disabled || rows.length <= 1}
            title={rows.length <= 1 ? t('至少保留一条路径', 'Keep at least one path') : t('删除这条路径', 'Remove this path')}
            aria-label={t(`删除第 ${i + 1} 行`, `Remove row ${i + 1}`)}
            onClick={() => remove(i)}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 2l6 6M8 2 2 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
          </button>
        </div>
      ))}
      <div className="pmix-foot">
        <button type="button" className="pmix-add" disabled={disabled} onClick={add}>
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M5 1.5v7M1.5 5h7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
          {t('添加路径', 'Add path')}
        </button>
        <span className={`pmix-total${totalProblem ? ' is-bad' : isFinite(total) ? ' is-ok' : ''}`} role="status">
          {!isFinite(total)
            ? t('合计 —', 'Total —')
            : totalProblem
              ? total < 100
                ? t(`合计 ${fmt(total)}%，还差 ${fmt(100 - total)}%`, `Total ${fmt(total)}%, ${fmt(100 - total)}% short`)
                : t(`合计 ${fmt(total)}%，多了 ${fmt(total - 100)}%`, `Total ${fmt(total)}%, ${fmt(total - 100)}% over`)
              : t('合计 100%', 'Total 100%')}
        </span>
      </div>
      {(rowMsgs.length > 0 || totalProblem) && (
        <p className="pmix-err">
          {rowMsgs.join(t('；', '; ')) || t('各路径比例合计须为 100%，否则无法运行。', 'The shares must add up to 100% before you can run.')}
        </p>
      )}
    </div>
  );
}
