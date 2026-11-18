import { useState } from 'react';
import { api } from '../api.ts';
import { useApp } from '../state.ts';
import { useT } from '../i18n/index.ts';
import { fmtDateTime, fmtInt, localZone } from '../format.ts';
import { isValidZoneName } from '../zone.ts';
import type { Settings } from '../../shared/api.ts';

const DEFAULT_WEIGHTS = [1, 1, 1, 1, 1, 0.5, 0.5];

export function SettingsPage() {
  const { settings, updateSettings, status, zone } = useApp();
  const t = useT();
  const [zoneDraft, setZoneDraft] = useState(settings.zone ?? '');
  const [rateDraft, setRateDraft] = useState(String(settings.usdJpy));
  const [reserveDraft, setReserveDraft] = useState(String(settings.reservePct));
  const [msg, setMsg] = useState<string | null>(null);
  const weights = settings.budgetWeekdayWeights;

  const saveZone = () => {
    const z = zoneDraft.trim();
    if (z && !isValidZoneName(z)) {
      setMsg(t('set.zoneInvalid'));
      return;
    }
    setMsg(null);
    void updateSettings({ zone: z || null });
  };

  const saveRate = () => {
    const r = Number(rateDraft);
    if (!Number.isFinite(r) || r <= 0 || r > 10000) {
      setMsg(t('set.rateInvalid'));
      return;
    }
    setMsg(null);
    void updateSettings({ usdJpy: r, usdJpyUpdatedAt: Date.now() });
  };

  const saveReserve = () => {
    const r = Number(reserveDraft);
    if (!Number.isFinite(r) || r < 0 || r > 50) {
      setMsg(t('set.reserveInvalid'));
      return;
    }
    setMsg(null);
    void updateSettings({ reservePct: r });
  };

  const setWeight = (i: number, v: number) => {
    const next = [...(weights ?? DEFAULT_WEIGHTS)];
    next[i] = Math.max(0, Math.min(10, v));
    void updateSettings({ budgetWeekdayWeights: next });
  };

  return (
    <div className="stack" style={{ maxWidth: 820 }}>
      <div className="card">
        <h2>{t('set.title')}</h2>
        {msg && (
          <div className="note warn" role="alert">
            {msg}
          </div>
        )}
        <div className="form-grid">
          <label htmlFor="s-l">{t('set.language')}</label>
          <select id="s-l" value={settings.language} onChange={(e) => void updateSettings({ language: e.target.value as Settings['language'] })}>
            <option value="system">{t('set.language.system')}</option>
            <option value="ja">日本語</option>
            <option value="en">English</option>
          </select>
          <label htmlFor="s-z">{t('set.zone')}</label>
          <span className="row">
            <input id="s-z" value={zoneDraft} placeholder={localZone()} onChange={(e) => setZoneDraft(e.target.value)} />
            <button className="btn" onClick={saveZone}>
              {t('common.save')}
            </button>
            <span className="faint">{t('set.current', { v: zone })}</span>
          </span>
          <label htmlFor="s-w">{t('set.weekStart')}</label>
          <select id="s-w" value={settings.weekStart} onChange={(e) => void updateSettings({ weekStart: Number(e.target.value) as 1 | 7 })}>
            <option value={1}>{t('set.monday')}</option>
            <option value={7}>{t('set.sunday')}</option>
          </select>
          <label htmlFor="s-c">{t('set.currency')}</label>
          <select id="s-c" value={settings.currency} onChange={(e) => void updateSettings({ currency: e.target.value as 'USD' | 'JPY' })}>
            <option value="USD">USD</option>
            <option value="JPY">JPY</option>
          </select>
          <label htmlFor="s-r">{t('set.rate')}</label>
          <span className="row">
            <input id="s-r" inputMode="decimal" value={rateDraft} onChange={(e) => setRateDraft(e.target.value)} style={{ width: 100 }} />
            <button className="btn" onClick={saveRate}>
              {t('common.save')}
            </button>
            <span className="faint">
              {t('set.rateUpdated')}: {settings.usdJpyUpdatedAt ? fmtDateTime(settings.usdJpyUpdatedAt, zone) : t('set.rateDefault')} · {t('set.rateNote')}
            </span>
          </span>
          <label htmlFor="s-p">{t('set.pricingMode')}</label>
          <select id="s-p" value={settings.pricingMode} onChange={(e) => void updateSettings({ pricingMode: e.target.value as 'historical' | 'current' })}>
            <option value="historical">{t('set.pricing.historical')}</option>
            <option value="current">{t('set.pricing.current')}</option>
          </select>
          <label htmlFor="s-t">{t('set.theme')}</label>
          <select id="s-t" value={settings.theme} onChange={(e) => void updateSettings({ theme: e.target.value as 'system' | 'light' | 'dark' })}>
            <option value="system">{t('set.theme.system')}</option>
            <option value="light">{t('set.theme.light')}</option>
            <option value="dark">{t('set.theme.dark')}</option>
          </select>
          <label htmlFor="s-d">{t('set.demo')}</label>
          <span className="row">
            <input id="s-d" type="checkbox" checked={settings.demo} onChange={(e) => void updateSettings({ demo: e.target.checked })} />
            <span className="faint">{t('set.demoNote')}</span>
          </span>
        </div>
        <div className="faint" style={{ marginTop: 10 }}>
          {t('set.pricingNote')}
        </div>
      </div>
      <div className="card">
        <h2>{t('set.plan')}</h2>
        <div className="form-grid">
          <label htmlFor="s-res">{t('set.reserve')}</label>
          <span className="row">
            <input id="s-res" inputMode="decimal" value={reserveDraft} onChange={(e) => setReserveDraft(e.target.value)} style={{ width: 70 }} />
            <button className="btn" onClick={saveReserve}>
              {t('common.save')}
            </button>
            <span className="faint">{t('set.reserve.note')}</span>
          </span>
          <span>{t('set.weights')}</span>
          <div className="stack" style={{ gap: 6 }}>
            <label className="row">
              <input type="radio" name="w" checked={weights == null} onChange={() => void updateSettings({ budgetWeekdayWeights: null })} />
              {t('set.weights.auto')}
            </label>
            <label className="row">
              <input type="radio" name="w" checked={weights != null} onChange={() => void updateSettings({ budgetWeekdayWeights: DEFAULT_WEIGHTS })} />
              {t('set.weights.custom')}
            </label>
            {weights && (
              <div className="row">
                {weights.map((w, i) => (
                  <label key={i} className="field">
                    {t(`wd.${i}`)}
                    <input type="number" min={0} max={10} step={0.25} value={w} onChange={(e) => setWeight(i, Number(e.target.value) || 0)} style={{ width: 60 }} />
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="card">
        <h2>{t('set.export')}</h2>
        <div className="row">
          {(['events', 'daily', 'quota'] as const).map((k) =>
            (['csv', 'json'] as const).map((f) => (
              <button
                key={`${k}-${f}`}
                className="btn"
                onClick={() => void api().exportData({ format: f, kind: k }).then((r) => setMsg(r.ok ? t('set.exportDone', { n: fmtInt(r.rows), path: r.path ?? '' }) : null))}
              >
                {t(`set.exportKind.${k}`)} ({f.toUpperCase()})
              </button>
            )),
          )}
        </div>
        <div className="faint" style={{ marginTop: 6 }}>
          {t('set.exportNote')}
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn" onClick={() => void api().importData().then((r) => setMsg(r.ok ? t('set.importDone', { inserted: r.inserted, skipped: r.skipped }) : (r.message ?? null)))}>
            {t('set.import')}
          </button>
        </div>
      </div>
      <div className="card">
        <h2>{t('set.data')}</h2>
        <div className="faint">{t('set.privacy')}</div>
        <div className="faint">DB: {status?.dbPath}</div>
        <div className="faint">
          {t('set.events', { n: status ? fmtInt(status.eventCount) : '—', from: fmtDateTime(status?.firstEventMs ?? null, zone), to: fmtDateTime(status?.lastEventMs ?? null, zone) })}
        </div>
        <button className="btn danger" style={{ marginTop: 8 }} onClick={() => void api().deleteAppData()}>
          {t('set.delete')}
        </button>
      </div>
    </div>
  );
}
