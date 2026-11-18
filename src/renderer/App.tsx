import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api.ts';
import { Ctx, defaultWindow, type AppCtx, type Filters } from './state.ts';
import { LangContext, resolveLang, translate } from './i18n/index.ts';
import { localZone, setFormatLang } from './format.ts';
import { languageOf } from '../shared/i18n/languages.ts';
import { useBusyPages } from './busy.ts';
import { LanguagePicker } from './components/LanguagePicker.tsx';
import { DEFAULT_SETTINGS, type AppStatus, type IngestStatus, type QuotaOverview, type Settings } from '../shared/api.ts';
import { Toolbar } from './components/Toolbar.tsx';
import { CalendarPage } from './pages/CalendarPage.tsx';
import { TimelinePage } from './pages/TimelinePage.tsx';
import { AnalysisPage } from './pages/AnalysisPage.tsx';
import { EstimatePage } from './pages/EstimatePage.tsx';
import { SourcesPage } from './pages/SourcesPage.tsx';
import { SettingsPage } from './pages/SettingsPage.tsx';
import { DashboardPage } from './pages/DashboardPage.tsx';
import { RatesPage } from './pages/RatesPage.tsx';

export type Page = 'dashboard' | 'calendar' | 'timeline' | 'rates' | 'analysis' | 'estimate' | 'sources' | 'settings';

const NAV: { id: Page; ico: string }[] = [
  { id: 'dashboard', ico: '◉' },
  { id: 'rates', ico: '⚖' },
  { id: 'calendar', ico: '▦' },
  { id: 'timeline', ico: '▥' },
  { id: 'analysis', ico: '◔' },
  { id: 'estimate', ico: '◎' },
  { id: 'sources', ico: '⇩' },
  { id: 'settings', ico: '⚙' },
];

export function App() {
  const now = new Date();
  const [page, setPage] = useState<Page>('dashboard');
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [quota, setQuota] = useState<QuotaOverview | null>(null);
  const [progress, setProgress] = useState<IngestStatus | null>(null);
  const [dataVersion, setDataVersion] = useState(0);
  const [slowVersion, setSlowVersion] = useState(0);
  const lastSlow = useRef(0);
  const mountedAt = useRef(Date.now());
  const [filters, setFiltersState] = useState<Filters>({
    provider: 'both',
    account: 'all',
    unit: 'day',
    measure: 'tokens',
    mode: 'daily',
    dimension: 'provider',
    models: [],
    projects: [],
    billingModes: [],
    includeSidechain: true,
    year: now.getFullYear(),
    month: now.getMonth() + 1,
    window: null,
  });
  const windowTouched = useRef(false);

  const setFilters = useCallback((f: Partial<Filters>) => {
    if ('window' in f) windowTouched.current = true;
    if ('provider' in f) windowTouched.current = false;
    setFiltersState((cur) => ({ ...cur, ...f }));
  }, []);

  useEffect(() => {
    void api().getSettings().then(setSettings);
  }, []);

  // データの変化を受けて再取得する（短い間隔の変化はまとめる）
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const offChanged = api().onDataChanged(() => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        setDataVersion((v) => v + 1);
      }, 150);
    });
    const offProgress = api().onIngestProgress(setProgress);
    return () => {
      offChanged();
      offProgress();
    };
  }, []);

  // 重い集計は、データの変化から最短30秒の間隔で更新する（使用中に処理が詰まらないように）
  useEffect(() => {
    // 起動直後（最初の取り込み中）は待たずに更新する
    const wait = Date.now() - mountedAt.current < 20000 ? 0 : lastSlow.current + 30000 - Date.now();
    const bump = () => {
      lastSlow.current = Date.now();
      setSlowVersion((v) => v + 1);
    };
    if (wait <= 0) {
      bump();
      return;
    }
    const id = setTimeout(bump, wait);
    return () => clearTimeout(id);
  }, [dataVersion]);

  useEffect(() => {
    void api().getStatus().then(setStatus);
    void api().quotaOverview().then(setQuota);
  }, [slowVersion, settings.demo]);

  // 枠の既定値: 選んだプロバイダーの週枠（両方のときは選ばない）
  useEffect(() => {
    if (windowTouched.current) return;
    const w = defaultWindow(quota, filters.provider, filters.unit === 'five_hour' ? 'five_hour' : 'week');
    if (w !== filters.window) setFiltersState((cur) => ({ ...cur, window: w }));
  }, [quota, filters.provider, filters.unit, filters.window]);

  useEffect(() => {
    const root = document.documentElement;
    if (settings.theme === 'system') delete root.dataset.theme;
    else root.dataset.theme = settings.theme;
    const l = resolveLang(settings.language);
    root.lang = languageOf(l).locale;
    // 右から左に書く言語を足したときのために、文字の向きも登録表に合わせる
    root.dir = languageOf(l).dir;
  }, [settings.theme, settings.language]);

  const updateSettings = useCallback(async (patch: Partial<Settings>) => {
    const s = await api().setSettings(patch);
    setSettings(s);
    setDataVersion((v) => v + 1);
  }, []);

  const zone = settings.zone ?? localZone();
  const ctx: AppCtx = useMemo(
    () => ({ settings, zone, money: { currency: settings.currency, usdJpy: settings.usdJpy }, filters, setFilters, status, quota, dataVersion, slowVersion, updateSettings }),
    [settings, zone, filters, setFilters, status, quota, dataVersion, slowVersion, updateSettings],
  );
  const lang = resolveLang(settings.language);
  // 書式（日時・期間）の言語は描画の前にそろえる
  setFormatLang(lang);
  const t = (k: string) => translate(lang, k);
  const busyPages = useBusyPages();
  const scanning = progress && progress.phase === 'scanning' && progress.filesTotal > 0;

  return (
    <LangContext.Provider value={lang}>
      <Ctx.Provider value={ctx}>
        <div className="app">
          <nav className="nav" aria-label="main">
            {NAV.map((n) => (
              <button key={n.id} aria-current={page === n.id ? 'page' : undefined} onClick={() => setPage(n.id)}>
                <span className={busyPages.has(n.id) ? 'ico busy' : 'ico'} aria-hidden="true">
                  {n.ico}
                </span>
                {t(`nav.${n.id}`)}
              </button>
            ))}
            <LanguagePicker compact id="nav-lang" value={settings.language} onChange={(v) => void updateSettings({ language: v })} />
          </nav>
          <div className="main">
            {(status?.demo || settings.demo) && (
              <div className="banner demo" role="status">
                {t('common.demoBanner')}
              </div>
            )}
            {scanning && (
              <div className="banner progress" role="status">
                {t('src.progress')}: {progress.filesDone.toLocaleString()} / {progress.filesTotal.toLocaleString()} (
                {Math.round((progress.bytesDone / Math.max(1, progress.bytesTotal)) * 100)}%)
              </div>
            )}
            {(page === 'calendar' || page === 'timeline' || page === 'analysis') && <Toolbar page={page} />}
            <div className="page">
              {page === 'dashboard' && <DashboardPage onNavigate={setPage} />}
              {page === 'rates' && <RatesPage />}
              {page === 'calendar' && <CalendarPage onOpenEstimate={() => setPage('estimate')} />}
              {page === 'timeline' && <TimelinePage />}
              {page === 'analysis' && <AnalysisPage />}
              {page === 'estimate' && <EstimatePage />}
              {page === 'sources' && <SourcesPage progress={progress} />}
              {page === 'settings' && <SettingsPage />}
            </div>
          </div>
        </div>
      </Ctx.Provider>
    </LangContext.Provider>
  );
}
