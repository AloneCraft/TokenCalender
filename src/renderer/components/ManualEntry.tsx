import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { useApp } from '../state.ts';
import { useT } from '../i18n/index.ts';
import { fmtDateTime } from '../format.ts';

type Row = Awaited<ReturnType<ReturnType<typeof api>['listManualObservations']>>[number];

function toLocalInput(ms: number): string {
  const d = new Date(ms - new Date().getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
}

/** 公式画面に表示された利用率とリセット日時を、手動で記録する（自動取得と区別して保存）。 */
export function ManualEntry() {
  const { zone, dataVersion } = useApp();
  const t = useT();
  const [rows, setRows] = useState<Row[]>([]);
  const [provider, setProvider] = useState<'claude' | 'codex'>('claude');
  const [windowMinutes, setWindowMinutes] = useState<300 | 10080>(10080);
  const [used, setUsed] = useState('');
  const [resets, setResets] = useState('');
  const [observed, setObserved] = useState(toLocalInput(Date.now()));
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    void api().listManualObservations().then(setRows);
  }, [dataVersion, version]);

  const submit = async () => {
    const u = Number(used);
    if (used.trim() === '' || !Number.isFinite(u) || u < 0 || u > 100) {
      setError('利用率は 0〜100 の数で入力してください');
      return;
    }
    const obs = Date.parse(observed);
    if (!Number.isFinite(obs)) {
      setError('確認した日時を入力してください');
      return;
    }
    const r = resets ? Date.parse(resets) : null;
    const res = await api().addManualObservation({
      provider,
      accountKey: null,
      limitId: provider,
      windowMinutes,
      usedPercent: u,
      resetsAtMs: r != null && Number.isFinite(r) ? r : null,
      observedAtMs: obs,
      note: note || null,
    });
    if (!res.ok) setError(res.message ?? '記録できませんでした');
    else {
      setError(null);
      setUsed('');
      setNote('');
      setVersion((v) => v + 1);
    }
  };

  return (
    <div className="card">
      <h2>{t('manual.title')}</h2>
      <div className="faint" style={{ marginBottom: 8 }}>
        「手動記録」として保存し、自動取得した値とは区別します。
      </div>
      <div className="form-grid">
        <label htmlFor="m-p">{t('manual.provider')}</label>
        <select id="m-p" value={provider} onChange={(e) => setProvider(e.target.value as 'claude' | 'codex')}>
          <option value="claude">Claude</option>
          <option value="codex">Codex</option>
        </select>
        <label htmlFor="m-w">{t('manual.window')}</label>
        <select id="m-w" value={windowMinutes} onChange={(e) => setWindowMinutes(Number(e.target.value) as 300 | 10080)}>
          <option value={10080}>週枠</option>
          <option value={300}>5時間枠</option>
        </select>
        <label htmlFor="m-u">{t('manual.used')}</label>
        <input id="m-u" inputMode="decimal" value={used} onChange={(e) => setUsed(e.target.value)} placeholder="35" />
        <label htmlFor="m-r">{t('manual.resets')}</label>
        <input id="m-r" type="datetime-local" value={resets} onChange={(e) => setResets(e.target.value)} />
        <label htmlFor="m-o">{t('manual.observed')}</label>
        <input id="m-o" type="datetime-local" value={observed} onChange={(e) => setObserved(e.target.value)} />
        <label htmlFor="m-n">{t('manual.note')}</label>
        <input id="m-n" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      {error && (
        <div className="note warn" role="alert" style={{ marginTop: 6 }}>
          {error}
        </div>
      )}
      <button className="btn primary" style={{ marginTop: 8 }} onClick={() => void submit()}>
        {t('manual.add')}
      </button>
      {rows.length > 0 && (
        <table className="tbl" style={{ marginTop: 10 }}>
          <tbody>
            {rows.slice(0, 20).map((r) => (
              <tr key={r.id}>
                <td>
                  {r.provider} {r.windowMinutes === 300 ? '5h' : '週'}
                </td>
                <td className="r">{r.usedPercent}%</td>
                <td>{fmtDateTime(r.observedAtMs, zone)}</td>
                <td>
                  <button className="btn" onClick={() => void api().deleteManualObservation(r.id).then(() => setVersion((v) => v + 1))}>
                    {t('manual.delete')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
