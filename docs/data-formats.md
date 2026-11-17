# 対応するデータ形式と読み取りの根拠

元のログは読み取りのみ。会話本文・コード・ツール出力・秘密情報は DB に保存しない。

## Claude Code（読み取り処理の版 `claude-2`）

保存先: `CLAUDE_CONFIG_DIR/projects`（設定時）、`~/.claude/projects`、`~/.config/claude/projects`、利用者が追加したフォルダー。
ファイル: `<project>/<session>.jsonl`、`<project>/<session>/subagents/agent-*.jsonl`、`subagents/workflows/wf_*/agent-*.jsonl`。

| 実ログで確認した事実 | 対応 |
| --- | --- |
| 1回の応答は内容ブロックごとに複数行へ同じ `message.id` と `usage` で書かれる | 鍵 `claude:msg:<message.id>` で1件にまとめる |
| 途中経過の行は `stop_reason` が null で、`output_tokens` だけが小さい（255 組を確認。入力・キャッシュは同じ） | 「最終値か」を最優先し、同じ段階なら出力が進んだ方を採用（rank）。置き換えたら `event_revisions` に記録 |
| 会話の再開で、同じ `message.id` の行が別ファイルにも写される（最近300ファイルで 56,273 件） | 鍵で重複排除。最初に読んだ方を残す |
| 応答の行は `message` が最上位の `type` より前に書かれる。ユーザー行は `promptId`・`type` が `message` より前 | ユーザー行は先頭の `type` で判定、応答の行は JSON を解釈して判定 |
| 応答の行に `promptId` が無い。直前のユーザー行（ツール結果を含む）の `promptId` がターンを示す | ファイル内で直前の `promptId` をターンとする |
| サブエージェントのファイルの `promptId` は親のターンと一致する（192 中 188） | 同じターンに属するサブエージェントとしてまとめ、`agentId` で区別 |
| 2026年10月のサブエージェントのログ 39,350 件は、最終値の行が無く出力が数トークンしか記録されていない | 「部分取得」として件数を表示。出力は過小（補えない） |
| `usage.iterations` は確認した範囲では常に1要素で最上位と同じ | 最上位を採用。複数要素で食い違えば印 `iterations_mismatch` |

トークンの扱い: `input_tokens` はキャッシュを含まない通常入力。`cache_creation_input_tokens` が書き込み総数で、5分・1時間の内訳は総数と一致する場合だけ使う。`thinking_tokens` は出力の内数。`model = "<synthetic>"` は API を呼んでいないため数えない。

## Codex（読み取り処理の版 `codex-4`）

保存先: `CODEX_HOME`（既定 `~/.codex`）の `sessions/` と `archived_sessions/`。`rollout-*.jsonl` と `rollout-*.jsonl.zst`。
同じフォルダーに平文と圧縮版がある場合は平文、`sessions` と `archived_sessions` の同名ファイルは `sessions` を読む（鍵による重複排除でも保証）。

| 実ログで確認した事実 | 対応 |
| --- | --- |
| `token_usage_record` は応答ごとの `usage` とスレッドの累積 `thread_token_usage` を持つ。usage の合計は累積と一致する | 記録があれば記録を正とし、鍵 `codex:resp:<response_id>` |
| 記録は新しい版から現れ、1つのファイルの途中から始まることがある | 記録が現れるまでは `token_count` を使い、境目の差だけを「記録の無い利用」として数える |
| `token_count` の累積は、記録の累積より少し小さいことがある | 記録が現れた後の `token_count` は使用量に使わない（利用率の観測だけに使う） |
| `token_count` だけのファイルで、1つの累積から2列に分かれて交互に書かれることがある。各列の中では 増分＝`last_token_usage` | 列を複数持ち、「列の前回値＋last＝今回」が成り立つ列の増分を数える |
| 同じ累積値の `token_count` が繰り返される | 数えない |
| 内訳が 0 で `total_tokens` だけの記録がある | 「分類不明」として合計に含め、金額は未換算 |
| fork・サブエージェントでは `subagent_history_start_ordinal` より前の行が親の履歴 | 数えず、累積の基準にする |
| `cached_input_tokens` は入力の内数、`reasoning_output_tokens` は出力の内数（`last_usage_includes_reasoning: true`） | 通常入力＝入力−キャッシュ。推論は出力に足さない |
| `cache_write_input_tokens` は常に 0（未検証） | 入力の内数と仮定し、0 でなければ印を付ける |
| `session_meta.creator_account_id` がある | アカウントの根拠として使う（ハッシュ化して保存） |
| `rate_limits` は `limit_id`、`primary`/`secondary` の `used_percent`・`window_minutes`・`resets_at`、`plan_type` を持つ | 枠は `window_minutes` で解釈し、primary/secondary を固定の意味にしない。null の枠は観測を作らない（0% にしない）。`window_minutes` が 0 の観測は「期間不明」 |

## 検証（このPC の実ログ、2026-11-18）

取り込み処理とは別の素朴な計算（`scripts/verify-codex-totals.ts`）とファイルごとに突き合わせた結果は [verification.md](verification.md) に記録する。

## 本アプリのステータスライン連携の記録（`bridge/claude-statusline.jsonl`）

1行1記録: `{"v":1,"ts":<ミリ秒>,"session_id":...,"model":...,"rate_limits":{"five_hour":{"used_percentage":..,"resets_at":..},"seven_day":{...}}}`。会話・パス・費用は書かない。

## DB（SQLite、表の版4）

`src/db/schema.ts` を参照。主な表:

| 表 | 内容 |
| --- | --- |
| `usage_events` | 正規化したログ使用量。版4から、取り込み時に「利用時点の単価」で計算した API料金換算（`cost_nano`、`priced`）も保存する（問い合わせを速くするため。単価表を変えたら計算し直す） |
| `event_revisions` | 途中値→最終値などの訂正履歴 |
| `turns` / `sessions` | ターン・セッション・親子関係 |
| `file_cursors` | ファイルごとの読み取り位置・先頭の指紋・読み取り処理の状態 |
| `quota_observations` | 公式利用率の観測（取得経路・取得時刻・刻み幅つき）。同じ枠・同じ値・同じリセット日時は15分ごとに1件に間引く。手動記録は `source = 'manual'` で保存し、間引かない |
| `quota_latest` | 枠ごとの最新の観測（間引かない。取得時刻の表示に使う） |
| `price_overrides` | 手動で追加した単価（組み込みの単価は `src/core/pricing/table.ts`） |
| `estimates` | 推定結果と推定条件（予約。現在は問い合わせのたびに計算） |
| `data_sources` / `accounts` / `settings` | データ元・アカウントの関連付け・設定 |

DB は1ファイルなので、外部の分析道具からも読み取り専用で開ける。
