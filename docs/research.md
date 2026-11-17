# 参照資料の調査結果

確認日: 2026-11-18（Asia/Tokyo）。ここに書いた内容は確認日時点のもので、以後の版で変わる可能性がある。

## 採用した部品の版

| 部品 | 版 | 確認 |
| --- | --- | --- |
| Electron | 45.2.3（内蔵 Node 24.22.2、Chromium 156、SQLite 3.53.4） | 公開 2026-11-04。`node:sqlite`・zstd 展開・別スレッドが動くことを実機で確認 |
| electron-vite / Vite | 6.0.0 / 8.3.8 | |
| React | 19.3.1 | |
| Apache ECharts | 6.1.0 | |
| Luxon | 3.7.2 | IANA タイムゾーン・夏時間の計算 |
| chokidar | 6.0.0 | ファイル監視 |
| TypeScript | 6.0.3 | 7.0.2 も公開済みだが、typescript-eslint 8.73.0 が `<6.1.0` までの対応のため 6.0.3 に固定 |
| Vitest / Playwright | 5.1.0 / 1.65.1 | |
| electron-builder | 26.18.0 | |

版は `package.json`（`--save-exact`）と `package-lock.json` で固定している。

注意: npm 11.20 は導入時のスクリプトを既定で実行しないため、Electron 本体は `node node_modules/electron/install.js` で取得する（README 参照）。

## 公式資料

| 資料 | 確認した内容 |
| --- | --- |
| https://code.claude.com/docs/en/statusline | ステータスラインの入力 JSON。`rate_limits.five_hour` / `seven_day` の `used_percentage`（0〜100）と `resets_at`（Unix 秒）。Pro / Max 等の契約者のみ、セッションの最初の応答の後にだけ現れる。枠ごとに欠けることがあり、`resets_at` を過ぎた枠は削除される。`refreshInterval` で定期実行もできる |
| https://code.claude.com/docs/en/hooks | 本アプリでは使っていない（ステータスラインで十分なため） |
| https://platform.claude.com/docs/en/about-claude/pricing | モデル別単価。5分キャッシュ書き込み＝入力×1.25、1時間＝×2。キャッシュ読み取りの倍率はモデルにより 0.025〜0.1。高速モードの単価（キャッシュ倍率も重なる）。`inference_geo: "us"` は 1.1 倍。長文脈の割増は Haiku 5.5（10万トークン超）だけ |
| https://developers.openai.com/api/docs/pricing | GPT-6 系の単価。短文脈 ≤272K。列は Input / Output / Cached input / 30m write / 12h write。推論トークンの課金についての記述は無い（出力の内数として扱う） |
| https://learn.chatgpt.com/docs/app-server（旧 developers.openai.com/codex/app-server） | `codex app-server` は stdio で JSON-RPC。`initialize` → `initialized` の手順。`account/rateLimits/read` 等の詳細は資料の後半にあり、未読（本アプリは未実装） |
| https://github.com/openai/codex | 未確認（ログ形式は実ログで確認した） |

OpenAI の料金ページは、要約ツール（WebFetch）の結果が2回で食い違った（1回目は存在しない gpt-5.6 系を列挙）。そのため、ページ本文を直接取得して表の値を確認した。`gpt-6.1-terra`・`gpt-6-luna`・`gpt-6-sol`・`gpt-5.3-codex` の標準価格は初期表示の表に無く、要約値（Flex 価格の2倍と一致）を `verified: false` として使っている。

## 参考にした既存ツール（コードは再利用していない）

| ツール | 確認 | ライセンス |
| --- | --- | --- |
| ccusage（https://ccusage.com/guide/codex/） | Codex: `token_count` の累積と直前値、平文と圧縮の重複、sessions と archived の重複、fork の基準値、`codex-auto-review` の扱い | ページのみ確認。コミットは未確認（gh 未ログイン） |
| ccusage #888（2026-03-11 起票、2026-05-17 解決） | Claude の同じ応答の複数行で、最初の途中値（出力 2）を採用して最終値（1,093）を捨てていた | — |
| ccusage #1288（2026-06-11 起票、2026-08-31 解決扱い） | Codex の同じ累積値の再通知と、fork の親履歴の再記録で 30〜67% 過大 | — |
| CodexBar（https://github.com/steipete/CodexBar） | OAuth API、ブラウザーの cookie、CLI の画面出力などで利用枠を取得。本アプリは認証情報を読む方式を採らない | MIT。コミットは未確認 |

過去の Issue は「今も残る不具合」とは扱わず、同じ失敗を防ぐ試験として取り込んだ（`tests/unit/claudeParser.test.ts` の E、`tests/unit/codexParser.test.ts` の F）。

## 実ログで確認した事実（このPC、2026-11-18）

ログの本文は読まず、項目名と数値だけを調べた。詳細は [data-formats.md](data-formats.md)。

- Claude: `~/.claude/projects/` に 2,820 ファイル、約12.3GB。512MB を超えるファイルもある（行ごとに流し読みする必要がある）。
- Codex: `~/.codex/sessions/`（平文 806、zstd 3,652）、`archived_sessions/`（2,218）。
- Codex の公式利用率はログの `token_count.rate_limits` に記録されている。この環境では `primary` が週枠（10080分）で `secondary` は null。過去には 5時間枠（300分）も記録されていた。
- Claude の公式利用率はログに無い。ステータスライン連携か手動記録が必要。
