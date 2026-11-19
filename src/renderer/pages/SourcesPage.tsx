import { useState } from 'react';
import { useBusy } from '../busy.ts';
import { BarGauge } from '../components/Gauge.tsx';
import { Icon } from '../components/Icons.tsx';
import { api } from '../api.ts';
import { useApp } from '../state.ts';
import { useMsg, useT } from '../i18n/index.ts';
import { fmtAgo } from '../format.ts';
import type { BillingMode, BridgePreview, IngestStatus } from '../../shared/api.ts';

const STATUS_BADGE: Record<string, string> = { ok: 'ok', missing: '', permission_denied: 'danger', error: 'danger', disabled: '', pending: 'warn' };

export function SourcesPage({ progress }: { progress: IngestStatus | null }) {
  const { status, quota, refreshStatus } = useApp();
  const t = useT();
  const tMsg = useMsg();
  const [msg, setMsg] = useState<string | null>(null);
  const [wsl, setWsl] = useState<{ distro: string; provider: 'claude' | 'codex'; path: string }[] | null>(null);
  const [preview, setPreview] = useState<BridgePreview | null>(null);
  const [accountDraft, setAccountDraft] = useState<Record<string, string>>({});
  // 変更中のデータ元。変更が終わるまで、その行の操作を止める（反応が無いように見えて、別の値を選んでしまうのを防ぐ）
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  // 変更中に画面へ出す値（選んだ直後に元の値へ戻って見えないようにする）
  const [chosen, setChosen] = useState<Record<string, BillingMode>>({});
  useBusy('sources', pending.size > 0);
  const now = Date.now();

  const update = async (sourceId: string, patch: { accountKey?: string | null; billingMode?: BillingMode; enabled?: boolean }) => {
    setPending((p) => new Set(p).add(sourceId));
    if (patch.billingMode) setChosen((c) => ({ ...c, [sourceId]: patch.billingMode! }));
    try {
      const r = await api().updateSource({ sourceId, ...patch });
      setMsg(r.ok ? null : t('src.updateFailed'));
    } catch (e) {
      setMsg(`${t('src.updateFailed')} (${String(e)})`);
    } finally {
      await refreshStatus().catch(() => undefined);
      setChosen((c) => {
        const { [sourceId]: _drop, ...rest } = c;
        return rest;
      });
      setPending((p) => {
        const n = new Set(p);
        n.delete(sourceId);
        return n;
      });
    }
  };

  const addFolder = async (provider: 'claude' | 'codex') => {
    const p = await api().pickFolder();
    if (!p) return;
    const r = await api().addSource({ provider, path: p });
    setMsg(r.ok ? t('src.added', { p }) : t('src.addFailed', { m: tMsg(r.message) }));
  };

  return (
    <div className="stack">
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2>{t('src.title')}</h2>
          <span className="row">
            <button className="btn" onClick={() => void addFolder('claude')}>
              {t('src.add')}（Claude）
            </button>
            <button className="btn" onClick={() => void addFolder('codex')}>
              {t('src.add')}（Codex）
            </button>
            <button className="btn" onClick={() => void api().detectWsl().then(setWsl)}>
              {t('src.wsl')}
            </button>
            <button className="btn" onClick={() => void api().rescan()}>
              {t('src.rescan')}
            </button>
          </span>
        </div>
        <div className="faint">{t('src.lead')}</div>
        {msg && <div className="note">{msg}</div>}
        {progress && progress.filesTotal > 0 && (
          <div className="src-progress">
            <BarGauge fill={(progress.filesDone / progress.filesTotal) * 100} tone="info" label={`${progress.filesDone} / ${progress.filesTotal}`} />
          </div>
        )}
        {progress && (
          <div className="faint" style={{ margin: '6px 0' }}>
            {t('src.progress')}:{' '}
            {t('src.progressLine', {
              phase: progress.phase,
              done: progress.filesDone.toLocaleString(),
              total: progress.filesTotal.toLocaleString(),
              ins: progress.eventsInserted.toLocaleString(),
              upd: progress.eventsUpdated.toLocaleString(),
              err: progress.errors,
            })}
          </div>
        )}
        <table className="tbl">
          <thead>
            <tr>
              <th>{t('src.col.source')}</th>
              <th>{t('src.col.status')}</th>
              <th className="r">{t('src.files')}</th>
              <th>{t('src.account')}</th>
              <th>{t('src.billing')}</th>
              <th>{t('src.enabled')}</th>
            </tr>
          </thead>
          <tbody>
            {(status?.sources ?? []).map((s) => (
              <tr key={s.sourceId}>
                <td>
                  {s.label ?? s.sourceId}
                  <div className="faint" style={{ wordBreak: 'break-all' }}>
                    {s.rootPath}
                  </div>
                </td>
                <td>
                  <span className={`badge ${STATUS_BADGE[s.status] ?? ''}`}>
                    <Icon name={s.status === 'ok' ? 'check' : s.status === 'pending' ? 'clock' : s.status === 'disabled' || s.status === 'missing' ? 'chat' : 'alert'} size={12} /> {t(`src.status.${s.status}`)}
                  </span>
                  {s.detail && <div className="faint">{s.detail}</div>}
                  {s.filesWithErrors > 0 && <div className="faint">{t('src.unreadable', { count: s.filesWithErrors })}</div>}
                  {s.badLines > 0 && (
                    <div className="faint">
                      {t('src.badLines')} {s.badLines}
                    </div>
                  )}
                  <div className="faint">{s.lastScanAt ? t('src.scanned', { ago: fmtAgo(s.lastScanAt, now) }) : ''}</div>
                </td>
                <td className="r">{s.fileCount.toLocaleString()}</td>
                <td>
                  <input
                    aria-label={t('src.account')}
                    placeholder={t('account.unknown')}
                    value={accountDraft[s.sourceId] ?? s.accountKey ?? ''}
                    onChange={(e) => setAccountDraft({ ...accountDraft, [s.sourceId]: e.target.value })}
                    disabled={pending.has(s.sourceId)}
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      if (v !== (s.accountKey ?? '')) void update(s.sourceId, { accountKey: v || null });
                    }}
                    style={{ width: 140 }}
                  />
                  <div className="faint">{t('src.accountNote')}</div>
                </td>
                <td>
                  <select
                    aria-label={t('src.billing')}
                    value={chosen[s.sourceId] ?? s.billingMode}
                    disabled={pending.has(s.sourceId)}
                    onChange={(e) => void update(s.sourceId, { billingMode: e.target.value as BillingMode })}
                  >
                    {(['unknown', 'subscription', 'api', 'extra_credit'] as const).map((b) => (
                      <option key={b} value={b}>
                        {t(`billing.${b}`)}
                      </option>
                    ))}
                  </select>
                  {pending.has(s.sourceId) && <span className="spinner" role="status" aria-label={t('common.loading')} style={{ marginLeft: 6, verticalAlign: 'middle', display: 'inline-block' }} />}
                </td>
                <td>
                  <input
                    type="checkbox"
                    aria-label={t('src.enabled')}
                    checked={s.enabled}
                    disabled={pending.has(s.sourceId)}
                    onChange={(e) => void update(s.sourceId, { enabled: e.target.checked })}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {wsl && (
          <div style={{ marginTop: 10 }}>
            <h3>WSL</h3>
            {wsl.length === 0 && <div className="faint">{t('src.notFound')}</div>}
            {wsl.map((w) => (
              <div key={w.path} className="row">
                <span>
                  {w.distro} · {w.provider} · <span className="faint">{w.path}</span>
                </span>
                <button className="btn" onClick={() => void api().addSource({ provider: w.provider, path: w.path }).then(() => setMsg(t('src.added', { p: w.path })))}>
                  {t('src.add')}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <h2>{t('src.quotaRoutes')}</h2>
        <table className="tbl">
          <tbody>
            {(quota?.sources ?? []).map((s) => (
              <tr key={s.source}>
                <td>{t(`quota.source.${s.source}`)}</td>
                <td>
                  <span className={`badge ${s.status === 'ok' ? 'ok' : s.status === 'failed' ? 'danger' : ''}`}>{s.status}</span>
                </td>
                <td className="faint">
                  {s.source === 'codex_app_server' ? t('src.appServerNote') : (s.detail ?? '')}
                  {s.updatedAt ? ` · ${fmtAgo(s.updatedAt, now)}` : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2>{t('bridge.title')}</h2>
        <div className="faint">{t('bridge.desc')}</div>
        <div className="row" style={{ marginTop: 8 }}>
          <button className="btn" onClick={() => void api().bridgePreview().then(setPreview)}>
            {t('bridge.preview')}
          </button>
          {preview && !preview.installed && (
            <button
              className="btn primary"
              onClick={() =>
                void api()
                  .bridgeInstall()
                  .then((r) => {
                    setMsg(r.ok ? t('bridge.enabled', { b: r.message ?? t('bridge.noBackup') }) : t('bridge.unchanged', { m: tMsg(r.message) }));
                    return api().bridgePreview().then(setPreview);
                  })
              }
            >
              {t('bridge.install')}
            </button>
          )}
          {preview?.installed && (
            <button
              className="btn"
              onClick={() =>
                void api()
                  .bridgeUninstall()
                  .then((r) => {
                    setMsg(r.ok ? t('bridge.restored') : t('bridge.unchanged', { m: tMsg(r.message) }));
                    return api().bridgePreview().then(setPreview);
                  })
              }
            >
              {t('bridge.uninstall')}
            </button>
          )}
        </div>
        {preview && (
          <div style={{ marginTop: 8 }}>
            <div className="faint">{t('bridge.target', { p: preview.settingsPath })}</div>
            <h3>{t('bridge.current')}</h3>
            <pre className="code">{JSON.stringify(preview.currentStatusLine, null, 2) ?? t('bridge.none')}</pre>
            <h3>{t('bridge.proposed')}</h3>
            <pre className="code">{JSON.stringify(preview.proposedStatusLine, null, 2)}</pre>
            <div className="faint">{t('bridge.script', { p: preview.scriptPath })}</div>
            <div className="faint">{t('bridge.output', { p: preview.outputPath })}</div>
            <div className="note" style={{ marginTop: 6 }}>
              {t(preview.note)}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
