import { useApp } from '../state.ts';
import { useT } from '../i18n/index.ts';
import type { Dimension, Measure, ProviderSel } from '../../shared/api.ts';
import { Seg } from './Seg.tsx';
import { windowName } from '../format.ts';

const DIMS: Dimension[] = ['none', 'provider', 'model', 'project', 'token_type', 'effort', 'billing', 'account', 'sidechain'];

export function Toolbar({ page }: { page: 'calendar' | 'timeline' | 'analysis' }) {
  const { filters, setFilters, status, quota, settings, updateSettings, zone } = useApp();
  const t = useT();
  const windows = (quota?.windows ?? []).filter((w) => filters.provider === 'both' || w.provider === filters.provider);
  const models = (status?.models ?? []).filter((m) => filters.provider === 'both' || m.provider === filters.provider);
  const accounts = (status?.accounts ?? []).filter((a) => filters.provider === 'both' || a.provider === filters.provider);
  const ym = `${filters.year}-${String(filters.month).padStart(2, '0')}`;
  const shiftMonth = (d: number) => {
    const m0 = filters.year * 12 + (filters.month - 1) + d;
    setFilters({ year: Math.floor(m0 / 12), month: (m0 % 12) + 1 });
  };
  return (
    <div className="toolbar" role="toolbar" aria-label="filters">
      <Seg<ProviderSel>
        label="provider"
        value={filters.provider}
        options={[
          ['claude', t('provider.claude')],
          ['codex', t('provider.codex')],
          ['both', t('provider.both')],
        ]}
        onChange={(provider) => setFilters({ provider, account: 'all' })}
      />
      <label className="field">
        <select aria-label={t('src.account')} value={filters.account} onChange={(e) => setFilters({ account: e.target.value })}>
          <option value="all">{t('account.all')}</option>
          {accounts.map((a) => (
            <option key={a.accountKey} value={a.accountKey}>
              {a.label ?? `${a.provider}: ${a.accountKey.slice(-8)}`}
            </option>
          ))}
          <option value="unknown">{t('account.unknown')}</option>
        </select>
      </label>
      {page === 'calendar' && (
        <Seg
          label="unit"
          value={filters.unit}
          options={[
            ['day', t('unit.day')],
            ['week', t('unit.week')],
            ['five_hour', t('unit.fiveHour')],
          ]}
          onChange={(unit) => setFilters({ unit })}
        />
      )}
      <Seg<Measure>
        label="measure"
        value={filters.measure === 'cost' ? 'cost' : 'tokens'}
        options={[
          ['tokens', t('measure.tokens')],
          ['cost', t('measure.cost')],
        ]}
        onChange={(measure) => setFilters({ measure })}
      />
      {page !== 'analysis' && (
        <Seg
          label="mode"
          value={filters.mode}
          options={[
            ['daily', t('mode.daily')],
            ['cumulative', t('mode.cumulative')],
          ]}
          onChange={(mode) => setFilters({ mode })}
        />
      )}
      <label className="field">
        <select aria-label={t('detail.breakdown')} value={filters.dimension} onChange={(e) => setFilters({ dimension: e.target.value as Dimension })}>
          {DIMS.map((d) => (
            <option key={d} value={d}>
              {t(`dim.${d}`)}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        {t('filter.models')}
        <select value={filters.models[0] ?? ''} onChange={(e) => setFilters({ models: e.target.value ? [e.target.value] : [] })}>
          <option value="">{t('filter.all')}</option>
          {models.map((m) => (
            <option key={`${m.provider}:${m.model}`} value={m.model}>
              {m.model}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        {t('filter.projects')}
        <select value={filters.projects[0] ?? ''} onChange={(e) => setFilters({ projects: e.target.value ? [e.target.value] : [] })}>
          <option value="">{t('filter.all')}</option>
          {(status?.projects ?? []).map((p) => (
            <option key={p.key} value={p.key}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <input type="checkbox" checked={filters.includeSidechain} onChange={(e) => setFilters({ includeSidechain: e.target.checked })} />
        {t('filter.subagents')}
      </label>
      {filters.mode === 'cumulative' && (
        <label className="field">
          {t('window.label')}
          <select value={filters.window ?? ''} onChange={(e) => setFilters({ window: e.target.value || null })}>
            <option value="">{t('window.none')}</option>
            {windows.map((w) => (
              <option key={w.key} value={w.key}>
                {w.provider === 'claude' ? 'Claude' : 'Codex'} {windowName(w.windowMinutes)}
                {w.limitId !== w.provider ? `（${w.limitId}）` : ''}
                {w.accountKey ? ` (${w.accountKey.slice(-6)})` : ''}
              </option>
            ))}
          </select>
        </label>
      )}
      {page === 'calendar' && (
        <span className="field" style={{ marginLeft: 'auto' }}>
          <button className="btn" aria-label={t('common.prev')} onClick={() => shiftMonth(-1)}>
            ‹
          </button>
          <input
            type="month"
            aria-label="month"
            value={ym}
            onChange={(e) => {
              const [y, m] = e.target.value.split('-').map(Number);
              if (y && m) setFilters({ year: y, month: m });
            }}
          />
          <button className="btn" aria-label={t('common.next')} onClick={() => shiftMonth(1)}>
            ›
          </button>
        </span>
      )}
      <label className="field">
        {t('zone.label')}
        <input
          aria-label={t('zone.label')}
          defaultValue={settings.zone ?? zone}
          list="tz-list"
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v && v !== zone) void updateSettings({ zone: v });
          }}
          style={{ width: 150 }}
        />
        <datalist id="tz-list">
          {['Asia/Tokyo', 'UTC', 'America/Los_Angeles', 'America/New_York', 'Europe/London', 'Europe/Berlin'].map((z) => (
            <option key={z} value={z} />
          ))}
        </datalist>
      </label>
    </div>
  );
}
