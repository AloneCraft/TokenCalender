// SQLite の表定義。版を上げるときは MIGRATIONS の末尾に追加する（既存の項目は書き換えない）。
//
// 4種類の数値の置き場所:
// - ログ使用量 ........ usage_events（トークン数のみ。金額は保存しない）
// - API料金換算 ....... usage_events.cost_nano（版4から。取り込み時に利用時点の単価で計算。単価表を変えたら計算し直す）
// - 公式利用率 ........ quota_observations（取得経路と取得時刻つき）
// - 推定 .............. estimates（推定条件と結果を JSON で保存）

export const MIGRATIONS: string[] = [
  `
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);

  CREATE TABLE IF NOT EXISTS accounts (
    account_key TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    label TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS data_sources (
    source_id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    kind TEXT NOT NULL,               -- auto / manual / wsl
    root_path TEXT NOT NULL,
    label TEXT,
    account_key TEXT,                 -- 利用者が関連付けたアカウント（null = 不明）
    billing_mode TEXT NOT NULL DEFAULT 'unknown',
    enabled INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'pending',   -- ok / missing / permission_denied / error / pending
    status_detail TEXT,
    file_count INTEGER NOT NULL DEFAULT 0,
    last_scan_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS file_cursors (
    file_key TEXT PRIMARY KEY,
    source_id TEXT NOT NULL,
    path TEXT NOT NULL,
    compressed INTEGER NOT NULL DEFAULT 0,
    size INTEGER NOT NULL,
    mtime_ms INTEGER NOT NULL,
    offset INTEGER NOT NULL,
    head_hash TEXT,
    parser_state TEXT,
    parser_version TEXT NOT NULL,
    bad_lines INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'ok',
    error TEXT,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    session_key TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    session_id TEXT NOT NULL,
    parent_session_id TEXT,
    source_id TEXT,
    account_key TEXT,
    project_key TEXT,
    project_label TEXT,
    originator TEXT,
    billing_mode TEXT NOT NULL DEFAULT 'unknown',
    first_ts INTEGER,
    last_ts INTEGER
  );

  CREATE TABLE IF NOT EXISTS turns (
    turn_key TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    session_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    started_at INTEGER,
    completed_at INTEGER,
    status TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS usage_events (
    event_key TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    source_id TEXT NOT NULL,
    account_key TEXT,
    session_id TEXT NOT NULL,
    parent_session_id TEXT,
    agent_id TEXT,
    is_sidechain INTEGER NOT NULL,
    turn_id TEXT,
    request_id TEXT,
    message_id TEXT,
    ts INTEGER NOT NULL,
    model TEXT,
    effort TEXT,
    speed TEXT,
    service_tier TEXT,
    inference_geo TEXT,
    project_key TEXT,
    project_label TEXT,
    billing_mode TEXT NOT NULL,
    input_uncached INTEGER NOT NULL,
    cache_read INTEGER NOT NULL,
    cache_write INTEGER NOT NULL,
    cache_write_5m INTEGER,
    cache_write_1h INTEGER,
    output INTEGER NOT NULL,
    reasoning INTEGER,
    provider_total INTEGER,
    total INTEGER NOT NULL,
    finality INTEGER NOT NULL,
    rank REAL NOT NULL,
    flags TEXT NOT NULL,
    origin_file_key TEXT NOT NULL,
    origin_offset INTEGER NOT NULL,
    parser_version TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0,
    ingested_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_events_ts ON usage_events(ts);
  CREATE INDEX IF NOT EXISTS idx_events_provider_ts ON usage_events(provider, ts);
  CREATE INDEX IF NOT EXISTS idx_events_session ON usage_events(session_id, turn_id);

  CREATE TABLE IF NOT EXISTS event_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_key TEXT NOT NULL,
    revision INTEGER NOT NULL,
    old_total INTEGER NOT NULL,
    new_total INTEGER NOT NULL,
    old_rank REAL NOT NULL,
    new_rank REAL NOT NULL,
    origin_file_key TEXT NOT NULL,
    at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_revisions_key ON event_revisions(event_key);

  CREATE TABLE IF NOT EXISTS quota_observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    obs_key TEXT NOT NULL UNIQUE,
    provider TEXT NOT NULL,
    account_key TEXT,
    plan_type TEXT,
    limit_id TEXT NOT NULL,
    window_kind TEXT NOT NULL,
    window_minutes INTEGER,
    scope_models TEXT,
    observed_at INTEGER NOT NULL,
    used_percent REAL,
    resets_at INTEGER,
    source TEXT NOT NULL,
    precision REAL NOT NULL,
    flags TEXT NOT NULL,
    origin_ref TEXT,
    note TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_quota_window ON quota_observations(provider, limit_id, window_minutes, observed_at);

  CREATE TABLE IF NOT EXISTS quota_source_status (
    source TEXT PRIMARY KEY,           -- codex_log / claude_statusline / codex_app_server
    status TEXT NOT NULL,              -- ok / not_configured / unsupported / unauthenticated / failed / no_window
    detail TEXT,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS price_overrides (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    effective_from INTEGER,
    effective_to INTEGER,
    rates_json TEXT NOT NULL,
    source_url TEXT,
    fetched_at INTEGER,
    origin TEXT NOT NULL DEFAULT 'manual'
  );

  CREATE TABLE IF NOT EXISTS estimates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    window_key TEXT NOT NULL,
    computed_at INTEGER NOT NULL,
    params_json TEXT NOT NULL,
    result_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_estimates_window ON estimates(window_key, computed_at);
  `,
  // 版2: 読み取り処理の版が変わったファイルのイベントを素早く消すための索引
  `CREATE INDEX IF NOT EXISTS idx_events_origin ON usage_events(origin_file_key);`,
  // 版3: 内訳の分からないトークン（合計だけが記録されていた分）
  `ALTER TABLE usage_events ADD COLUMN unclassified INTEGER NOT NULL DEFAULT 0;`,
  // 版4: 問い合わせを速くするため、API料金換算を取り込み時に計算して保存する（単価表を変えたら計算し直す）。
  //      公式利用率の最新値は別表に必ず保持する（同じ値の観測は間引くため）。
  `
  ALTER TABLE usage_events ADD COLUMN cost_nano INTEGER;
  ALTER TABLE usage_events ADD COLUMN priced INTEGER;
  CREATE INDEX IF NOT EXISTS idx_events_cost_pending ON usage_events(ts) WHERE cost_nano IS NULL;
  CREATE TABLE IF NOT EXISTS quota_latest (
    window_key TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    account_key TEXT,
    limit_id TEXT NOT NULL,
    window_kind TEXT NOT NULL,
    window_minutes INTEGER,
    scope_models TEXT,
    plan_type TEXT,
    observed_at INTEGER NOT NULL,
    used_percent REAL,
    resets_at INTEGER,
    source TEXT NOT NULL,
    precision REAL NOT NULL,
    flags TEXT NOT NULL
  );
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;
