# Token Calendar

**📖 説明書: https://alonecraft.github.io/TokenCalender/** ・ **User guide (English): https://alonecraft.github.io/TokenCalender/en/**

Claude Code と OpenAI Codex の使用量をローカルのログから集計し、カレンダーとチャートで表示するデスクトップアプリ。
公式の利用枠の利用率と照合して、週制限の「実効容量」（自分の使い方で週枠が何トークン・何ドル相当に当たるか）を推定する。

## ダウンロード

**[最新版を入手する（Releases）](https://github.com/AloneCraft/TokenCalender/releases/latest)**: Windows 用インストーラー `Token Calendar Setup x.y.z.exe`

1. Releases の「Assets」から `Token Calendar Setup x.y.z.exe` をダウンロードして実行する
2. インストール先を選んで進める（管理者権限は不要）
3. 「Windows によって PC が保護されました」と出た場合は、「詳細情報」→「実行」を選ぶ。コード署名をしていないための表示

Node.js などの別途の導入は要らない。macOS・Linux 版は未確認のため配布していない。

ライセンスは MIT（[LICENSE.txt](LICENSE.txt)）。

名称は `src/shared/appInfo.ts` と `electron-builder.yml` で変えられる。

## 4種類の数値を区別する

| 種類 | 意味 |
| --- | --- |
| ログ使用量 | 端末上のログに記録されたトークン量（重複を除いた正規化後の値） |
| API料金換算 | 同じトークン量を API 単価で払った場合の参考額。実際の請求額ではない |
| 公式利用率 | Codex ログ・Claude ステータスライン・手動記録から得た、取得時点の利用枠の利用率 |
| 推定 | 上の3つから計算した実効容量・補助推定・予測。公式の上限ではない |

## 主な機能

- 利用枠ダッシュボード（最初の画面）: 公式の残り、リセットまでの時間、今日あと使える量（1日ごとの予算）、リセット時に残る見込みと持つ確率、今のモデル・エフォートであと何回依頼できるか、次に作業を止める可能性がある枠、根拠つきの提案、使い方を変えた場合のシミュレーター
- モデル別消費: 期間を選んで、モデル×エフォートごとに公式の利用枠をどれだけ減らすか（1回あたり・100万トークンあたり・1セッションあたり、幅つき）を推定する。API 料金は使わない
- 表示言語は OS の言語設定に合わせる（日本語・English・한국어・简体中文・繁體中文・Español・Português (Brasil)・Français・Deutsch・Русский・Українська。無い言語の OS では英語）。国旗つきの選択欄で切り替えられる。言語の追加手順は [docs/i18n.md](docs/i18n.md)
- 月間カレンダー（日付ごとに縦棒1本）。日別使用量／リセット周期内累積（薄色＝前日までの累計、濃色＝当日分）
- 時系列ページ: N日単位で過去M日、5時間単位で過去M枠、暦週。上段は区間ごと、下段はリセットで 0 に戻る累積
- 直近の利用: 今回のターン・セッション累計・内訳・状態（実行中／部分取得／記録済み／更新待ち）
- 利用枠と推定: 公式利用率（取得時刻つき）、実効容量の推定（幅・採用／除外の理由）、残量とペース
- 分析: 図の登録簿（`src/renderer/charts/registry.ts`）から選ぶ。曜日×時間帯、キャッシュ比率など
- データ元の状態表示、フォルダー追加、WSL 検出、アカウントの関連付け、課金区分の設定
- 手動記録（公式画面の利用率とリセット日時）、CSV/JSON 書き出し、他端末の書き出しの取り込み、データ削除、デモ表示

## 動作の前提

- 利用者に Node.js などの別途導入は不要（Electron に Node と SQLite が含まれる）。
- ログは外部へ送信しない。外部通信は行わない。元のログは読むだけ。
- Claude Code の設定（statusLine）を変えるのは、利用者が画面と確認ダイアログの両方で同意したときだけ。

## 起動（Windows）

`run.bat` をダブルクリックする。初回は依存部品の導入と Electron 本体の取得を自動で行い、組み立ててから起動する。
`run.bat dev` で開発モード（画面の変更がすぐ反映される）になる。Node.js 22.15 以上が必要。

## 開発

必要なもの: Node.js 22.15 以上（開発のみ）。

```bash
npm ci
```

```bash
node node_modules/electron/install.js
```

npm 11 以降は導入時のスクリプトを自動で実行しないため、Electron 本体は上のコマンドで取得する。

```bash
npm run dev
```

データの置き場所を変えて起動する場合（既定は OS の利用者データフォルダー）:

```bash
TOKEN_CALENDAR_DATA_DIR=D:/CodexTemp/TokenCalendar/dev-data npm run dev
```

## 検証手順

変更に近い短い確認から順に行う（共有の段階別検証規約に従う）。

| 段階 | コマンド | 合格条件 |
| --- | --- | --- |
| 型（英語の訳し漏れも検出） | `npm run typecheck` | エラーなし |
| 静的検査 | `npm run lint` | エラーなし |
| 単体（必須試験 A〜R の大半） | `npm run test` | 全件合格 |
| 画面の通し（N・O・R など） | `npm run e2e` | 全件合格。試験用のログだけを読む（`TOKEN_CALENDAR_HOME`） |
| 実ログの取り込み | `node scripts/ingest-cli.ts <DBのパス> --again` | エラー 0、2回目の走査で件数が増えない |
| Codex 合計の独立検証 | `node scripts/verify-codex-totals.ts <DBのパス> 1500` | 種類ごとの差が verification.md の記録から悪化しない |
| 画面の問い合わせ時間 | `node scripts/bench-queries.ts <DBのパス>` | カレンダーが 1 秒未満 |
| 取り込みの新旧経路の一致 | `npx vitest run tests/unit/byteFeed.test.ts` | 合格（バイトのまま振り分ける経路と文字列の経路が同じ結果） |
| カレンダー・時系列・元イベントの一致 | `node scripts/check-consistency.ts <DBのパス>` | 3つが一致 |
| 配布物の起動とメモリ | `node scripts/check-packaged.ts <exe> <データ> [ログのホーム]` | 画面が出る（Playwright 経由では遅く出る点に注意） |

既存の DB を新しい版で開いたときの後片付け（重複の間引き・金額の計算）は、アプリの起動時に自動で行う。画面なしで行う場合は `node scripts/maintain-db.ts <DBのパス>`。

一時ファイルの置き場所は `TOKEN_CALENDAR_TEST_TMP` で指定できる（未指定なら `D:/CodexTemp` があればそこ）。

## 配布物の作成

```bash
npm run dist:win
```

`release/` に Windows x64 のインストーラーができる。macOS（`dist:mac`）・Linux（`dist:linux`）の設定もあるが、未確認（[docs/support-matrix.md](docs/support-matrix.md)）。

第三者ライセンス表示は `node scripts/gen-notices.cjs` で作り直せる（[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)）。

## 文書

- [docs/research.md](docs/research.md): 参照資料・採用した版・確認日
- [docs/data-formats.md](docs/data-formats.md): 対応するログ形式と読み取りの根拠、DB の表
- [docs/estimation.md](docs/estimation.md): 推定の方法と限界
- [docs/support-matrix.md](docs/support-matrix.md): 対応 OS とデータ元
- [docs/verification.md](docs/verification.md): 試験・性能測定の結果、確認できたこと／未確認のこと

## フォルダー構成

```
src/core/      Electron に依存しない処理（正規化・集計・料金・推定・時間）
src/db/        SQLite の表と読み書き
src/ingest/    探索・差分読み・監視（別スレッド）
src/query/     画面からの問い合わせ（別スレッド）
src/main/      Electron 本体・preload・ステータスライン連携
src/renderer/  画面（React + ECharts）
tests/         単体試験・画面の通し試験・試験用ログの組み立て
scripts/       開発用の取り込み・検証・ライセンス表示の生成
```
