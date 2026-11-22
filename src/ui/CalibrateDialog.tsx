// Calibrate the current topology from production metrics (CSV): paste or load a file, preview what
// would change, apply, and see a verification run of simulated vs measured values.
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CAL_COLUMNS, calibrate, parseCalibrationCsv, templateCsv, verifyCalibration,
  type CalibrationResult, type VerifyResult,
} from '../engine/calibrate';
import { useStore } from './store';
import { useT } from './i18n';
import { fmtLatency, fmtPct, fmtRate } from './format';

type Step = 'input' | 'preview' | 'done';

export function CalibrateDialog() {
  const t = useT();
  const open = useStore((s) => s.calOpen);
  if (!open) return null;
  return <Dialog key="cal" t={t} />;
}

function Dialog({ t }: { t: ReturnType<typeof useT> }) {
  const lang = useStore((s) => s.lang);
  const topology = useStore((s) => s.topology);
  const setOpen = useStore((s) => s.setCalOpen);
  const applyCalibrated = useStore((s) => s.applyCalibrated);
  const undoCalibration = useStore((s) => s.undoCalibration);
  const showToast = useStore((s) => s.showToast);
  // opened with a prepared CSV (from fetched real metrics): start from it
  const [preset] = useState(() => useStore.getState().calPreset);
  const [text, setText] = useState(preset?.text ?? '');
  const [source, setSource] = useState(preset?.source ?? 'CSV');
  const [overhead, setOverhead] = useState(0);
  const [step, setStep] = useState<Step>('input');
  const [result, setResult] = useState<CalibrationResult | null>(null);
  const [verify, setVerify] = useState<VerifyResult | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const tx = (x: { zh: string; en: string }) => x[lang];

  const parsed = useMemo(() => (text.trim() ? parseCalibrationCsv(text) : null), [text]);
  const close = () => setOpen(false);

  const preview = () => {
    if (!parsed || !parsed.rows.length) return;
    setResult(calibrate(topology, parsed.rows, { cpuOverhead: overhead / 100, source }));
    setStep('preview');
  };
  // a prepared CSV goes straight to the preview of what would change
  useEffect(() => { if (preset) preview(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const apply = () => {
    if (!result) return;
    setBusy(true);
    // let the "verifying" state paint before the synchronous simulation run
    setTimeout(() => {
      let v: VerifyResult | null = null;
      try { v = verifyCalibration(result.topology, result.matches, { cpuOverhead: overhead / 100 }); } catch (err) { console.error(err); }
      const topo = { ...result.topology, calibration: { ...result.topology.calibration!, medianError: v?.medianError } };
      applyCalibrated(topo);
      setVerify(v);
      setBusy(false);
      setStep('done');
      showToast(t('已应用校准参数', 'Calibration applied'));
    }, 30);
  };

  const download = () => {
    const url = URL.createObjectURL(new Blob([templateCsv(topology)], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url; a.download = `${topology.name.replace(/[\s/\\]+/g, '-')}-metrics.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const metricLabel = (m: string) => ({
    qps: t('QPS', 'QPS'), avg_ms: t('平均响应时间', 'Mean response time'), cpu_util: t('CPU 利用率', 'CPU utilization'), hit_ratio: t('命中率', 'Hit ratio'),
  } as Record<string, string>)[m] ?? m;
  const metricValue = (m: string, v: number) => (m === 'qps' ? `${fmtRate(v)}/s` : m === 'avg_ms' ? fmtLatency(v) : fmtPct(v));

  return (
    <div className="modal-scrim" onClick={close}>
      <div className="modal modal--wide cal" role="dialog" aria-modal="true" aria-label={t('用生产指标校准', 'Calibrate from production metrics')} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>{t('用生产指标校准', 'Calibrate from production metrics')}</span>
          <button type="button" className="icon-btn" aria-label={t('关闭', 'Close')} onClick={close}>
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          </button>
        </div>

        {step === 'input' && (
          <div className="cal-body">
            <p className="cal-lead">
              {t(
                '填入一个典型高峰小时的指标，每个组件一行，按名字对应画布上的节点。Microwave 会反推处理时间和 CPU 占比，让仿真的“今天”对上生产基线。空着的格子保留当前值。',
                'Enter metrics from a typical peak hour, one row per component, matched to canvas nodes by name. Microwave backsolves processing times and CPU shares so the simulated “today” matches the production baseline. Blank cells keep the current value.',
              )}
            </p>
            <div className="cal-actions">
              <button type="button" className="btn" onClick={() => { setText(templateCsv(topology)); setSource(t('画布模板', 'canvas template')); }}>{t('用当前画布生成模板', 'Fill template from canvas')}</button>
              <button type="button" className="btn" onClick={download}>{t('下载模板 CSV', 'Download template CSV')}</button>
              <button type="button" className="btn" onClick={() => fileRef.current?.click()}>{t('打开 CSV 文件…', 'Open CSV file…')}</button>
              <input ref={fileRef} type="file" accept=".csv,text/csv" hidden onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (!f) return;
                setText(await f.text());
                setSource(f.name);
              }} />
            </div>
            <textarea
              className="cal-text"
              value={text}
              spellCheck={false}
              onChange={(e) => { setText(e.target.value); setSource(t('粘贴的 CSV', 'pasted CSV')); }}
              placeholder={CAL_COLUMNS.join(',') + '\nCatalog service,service,480,62,,0.38,6,2,100,'}
              aria-label={t('指标 CSV', 'Metrics CSV')}
            />
            <details className="cal-cols">
              <summary>{t('各列含义', 'What each column means')}</summary>
              <dl>
                <dt>name</dt><dd>{t('和画布上的组件名一致（不区分大小写）', 'Same as the component name on the canvas (case-insensitive)')}</dd>
                <dt>type</dt><dd>{t('可选：client、gateway、lb、service、cache、database、queue', 'Optional: client, gateway, lb, service, cache, database, queue')}</dd>
                <dt>qps</dt><dd>{t('到达这个组件的请求数/秒', 'Requests per second arriving at the component')}</dd>
                <dt>avg_ms</dt><dd>{t('服务端平均响应时间，含它调用下游的时间；缓存填命令本身的耗时', 'Server-side mean response time, including its downstream calls; for a cache, the command time itself')}</dd>
                <dt>p99_ms</dt><dd>{t('可选，用来设定处理时间的长尾形状', 'Optional; sets the tail shape of the processing time')}</dd>
                <dt>cpu_util</dt><dd>{t('CPU 利用率，相对于 CPU limit，0.38 或 38%', 'CPU utilization against the CPU limit, 0.38 or 38%')}</dd>
                <dt>pods · cores_per_pod · threads_per_pod</dt><dd>{t('实例数、每个 pod 的 CPU limit、线程池大小', 'Instances, CPU limit per pod, thread pool size')}</dd>
                <dt>db_pool_per_pod</dt><dd>{t('每个 pod 到数据库的连接池大小', 'Database connection pool size per pod')}</dd>
                <dt>max_connections · hit_ratio</dt><dd>{t('数据库连接上限；缓存命中率', 'Database connection limit; cache hit ratio')}</dd>
              </dl>
            </details>
            <label className="cal-overhead">
              <span>{t('CPU 额外开销', 'CPU overhead')}</span>
              <input type="number" className="num" min={0} max={90} step={5} value={overhead} onChange={(e) => setOverhead(Math.min(90, Math.max(0, Number(e.target.value) || 0)))} />
              <span>%</span>
              <small>{t('不由请求产生的 CPU（GC、sidecar、日志、定时任务）', 'CPU not caused by requests (GC, sidecars, logging, cron jobs)')}</small>
            </label>
            {parsed && parsed.errors.length > 0 && (
              <ul className="cal-notes">{parsed.errors.map((e, i) => <li key={i}>{tx(e)}</li>)}</ul>
            )}
            <div className="cal-foot">
              <span className="cal-count">{parsed ? t(`${parsed.rows.length} 行数据`, `${parsed.rows.length} data rows`) : ''}</span>
              <button type="button" className="btn" onClick={close}>{t('取消', 'Cancel')}</button>
              <button type="button" className="btn btn--primary" disabled={!parsed || !parsed.rows.length} onClick={preview}>{t('预览校准结果', 'Preview calibration')}</button>
            </div>
          </div>
        )}

        {step === 'preview' && result && (
          <div className="cal-body">
            <p className="cal-lead">
              {t(
                `匹配到 ${result.matches.length} 个组件，${result.changes.length} 处参数会改变。${result.converged ? '' : '迭代没有完全收敛。'}应用后会跑 60 秒仿真，对比测量值。`,
                `Matched ${result.matches.length} components; ${result.changes.length} parameters will change.${result.converged ? '' : ' The fit did not fully converge.'} Applying runs a 60-second simulation to compare against the measurements.`,
              )}
            </p>
            {result.unmatched.length > 0 && (
              <p className="cal-warn-line">{t('画布上找不到：', 'Not found on the canvas: ')}{result.unmatched.map((r) => r.name).join(lang === 'en' ? ', ' : '、')}</p>
            )}
            {result.warnings.length > 0 && (
              <ul className="cal-notes cal-notes--warn">
                {result.warnings.map((w, i) => <li key={i}>{w.nodeName && <b>{w.nodeName}: </b>}{tx(w.text)}</li>)}
              </ul>
            )}
            <div className="cap-table-wrap cal-table">
              <table className="cap-table">
                <thead><tr><th>{t('组件', 'Component')}</th><th>{t('参数', 'Parameter')}</th><th className="r">{t('现在', 'Now')}</th><th className="r">{t('校准后', 'Calibrated')}</th></tr></thead>
                <tbody>
                  {result.changes.map((c, i) => (
                    <tr key={i}><th>{c.nodeName}</th><td>{tx(c.what)}</td><td className="r">{c.from}</td><td className="r"><b>{c.to}</b></td></tr>
                  ))}
                  {!result.changes.length && <tr><td colSpan={4}>{t('没有参数需要改变', 'Nothing to change')}</td></tr>}
                </tbody>
              </table>
            </div>
            <div className="cal-foot">
              <span className="cal-count">{busy ? t('正在跑验证仿真…', 'Running the verification simulation…') : ''}</span>
              <button type="button" className="btn" disabled={busy} onClick={() => setStep('input')}>{t('返回修改', 'Back')}</button>
              <button type="button" className="btn btn--primary" disabled={busy || !result.changes.length} onClick={apply}>{t('应用并验证', 'Apply and verify')}</button>
            </div>
          </div>
        )}

        {step === 'done' && (
          <div className="cal-body">
            {verify ? (
              <>
                <p className="cal-lead">
                  {t(
                    `已应用。在测得的负载下仿真 ${verify.seconds} 秒，误差中位数 ${fmtPct(verify.medianError)}，最大 ${fmtPct(verify.maxError)}。${verify.medianError <= 0.1 ? '基线已对上，可以开始做假设推演。' : '误差偏大，先看下面误差最大的几项和上一步的提示。'}`,
                    `Applied. Simulated ${verify.seconds} seconds at the measured load: median error ${fmtPct(verify.medianError)}, max ${fmtPct(verify.maxError)}. ${verify.medianError <= 0.1 ? 'The baseline matches; what-if runs can start from here.' : 'The error is high; check the largest rows below and the notes from the previous step.'}`,
                  )}
                </p>
                <div className="cap-table-wrap cal-table">
                  <table className="cap-table">
                    <thead><tr><th>{t('组件', 'Component')}</th><th>{t('指标', 'Metric')}</th><th className="r">{t('测量', 'Measured')}</th><th className="r">{t('仿真', 'Simulated')}</th><th className="r">{t('误差', 'Error')}</th></tr></thead>
                    <tbody>
                      {verify.lines.map((l, i) => (
                        <tr key={i}>
                          <th>{l.nodeName}</th><td>{metricLabel(l.metric)}</td>
                          <td className="r">{metricValue(l.metric, l.measured)}</td>
                          <td className="r">{metricValue(l.metric, l.simulated)}</td>
                          <td className={`r ${l.error > 0.15 ? 'cal-bad' : l.error > 0.1 ? 'cal-meh' : ''}`}>{fmtPct(l.error)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : (
              <p className="cal-lead">{t('已应用，但验证仿真没有跑成功，详情见浏览器控制台。', 'Applied, but the verification run failed; see the browser console.')}</p>
            )}
            <div className="cal-foot">
              <span className="cal-count" />
              <button type="button" className="btn" onClick={() => { undoCalibration(); close(); showToast(t('已撤销校准', 'Calibration undone')); }}>{t('撤销校准', 'Undo calibration')}</button>
              <button type="button" className="btn btn--primary" onClick={close}>{t('完成', 'Done')}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
