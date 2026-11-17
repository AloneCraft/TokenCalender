import { useState } from 'react';
import { api } from '../api.ts';
import { useApp } from '../state.ts';
import { useT } from '../i18n/index.ts';
import { fmtDateTime, localZone } from '../format.ts';
import { isValidZoneName } from '../zone.ts';

export function SettingsPage() {
  const { settings, updateSettings, status, zone } = useApp();
  const t = useT();
  const [zoneDraft, setZoneDraft] = useState(settings.zone ?? '');
  const [rateDraft, setRateDraft] = useState(String(settings.usdJpy));
  const [msg, setMsg] = useState<string | null>(null);

  const saveZone = () => {
    const z = zoneDraft.trim();
    if (z && !isValidZoneName(z)) {
      setMsg('タイムゾーン名が正しくありません（例: Asia/Tokyo）');
      return;
    }
    setMsg(null);
    void updateSettings({ zone: z || null });
  };

  const saveRate = () => {
    const r = Number(rateDraft);
    if (!Number.isFinite(r) || r <= 0 || r > 10000) {
      setMsg('為替レートは正の数で入力してください');
      return;
    }
    setMsg(null);
    void updateSettings({ usdJpy: r, usdJpyUpdatedAt: Date.now() });
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
          <label htmlFor="s-z">{t('set.zone')}</label>
          <span className="row">
            <input id="s-z" value={zoneDraft} placeholder={localZone()} onChange={(e) => setZoneDraft(e.target.value)} />
            <button className="btn" onClick={saveZone}>
              {t('common.save')}
            </button>
            <span className="faint">現在: {zone}</span>
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
              {t('set.rateUpdated')}: {settings.usdJpyUpdatedAt ? fmtDateTime(settings.usdJpyUpdatedAt, zone) : '既定値（未設定）'}・為替を変えると過去分の円表示も現在のレートで換算し直します
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
          <label htmlFor="s-l">{t('set.language')}</label>
          <select id="s-l" value={settings.language} onChange={(e) => void updateSettings({ language: e.target.value as 'ja' | 'en' })}>
            <option value="ja">日本語</option>
            <option value="en">English（一部）</option>
          </select>
          <label htmlFor="s-d">{t('set.demo')}</label>
          <span className="row">
            <input id="s-d" type="checkbox" checked={settings.demo} onChange={(e) => void updateSettings({ demo: e.target.checked })} />
            <span className="faint">オンにすると架空のデータを表示します。実データとは別に保存され、混ざりません。</span>
          </span>
        </div>
        <div className="faint" style={{ marginTop: 10 }}>
          {t('set.pricingNote')}
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
                onClick={() => void api().exportData({ format: f, kind: k }).then((r) => setMsg(r.ok ? `${r.rows.toLocaleString()} 行を書き出しました: ${r.path}` : null))}
              >
                {k === 'events' ? 'イベント' : k === 'daily' ? '日別' : '公式利用率'}（{f.toUpperCase()}）
              </button>
            )),
          )}
        </div>
        <div className="faint" style={{ marginTop: 6 }}>
          書き出しには会話の本文やファイルのパスを含めません。金額の列は API 料金換算の参考額です。
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn" onClick={() => void api().importData().then((r) => setMsg(r.ok ? `取り込み: 追加 ${r.inserted} 件、重複などで除外 ${r.skipped} 件` : (r.message ?? null)))}>
            {t('set.import')}
          </button>
        </div>
      </div>
      <div className="card">
        <h2>データ</h2>
        <div className="faint">{t('set.privacy')}</div>
        <div className="faint">DB: {status?.dbPath}</div>
        <div className="faint">
          イベント {status?.eventCount.toLocaleString() ?? '—'} 件 ・ {fmtDateTime(status?.firstEventMs ?? null, zone)} 〜 {fmtDateTime(status?.lastEventMs ?? null, zone)}
        </div>
        <button className="btn danger" style={{ marginTop: 8 }} onClick={() => void api().deleteAppData()}>
          {t('set.delete')}
        </button>
      </div>
    </div>
  );
}
