# 対応環境

利用者に Node.js・npm・Python・jq などの別途導入は求めない（Electron に Node と SQLite が含まれる）。

| OS | 構成 | 状態 |
| --- | --- | --- |
| Windows 11 | x64 | 動作確認済み（2026-11-18、開発用起動・単体試験・画面の通し試験・実ログ取り込み・配布物 win-unpacked の起動）。インストーラーの実行は未確認 |
| Windows | ARM64 | 未確認。Electron は ARM64 版があり、本アプリにネイティブ部品が無いため対応できる見込み。配布設定に未追加 |
| macOS | Apple Silicon / Intel | 未確認。配布設定（dmg、arm64 と x64）のみ用意。署名・公証は未設定 |
| Linux | x64 | 未確認。配布設定（AppImage）のみ用意 |
| Linux | ARM64 | 未確認。配布設定に未追加 |

## 表示言語

対応言語: 日本語・English・한국어（アプリの画面。説明書は日本語と英語のみ）。既定は OS の言語設定に合わせる（登録された言語から選び、無ければ英語）。設定画面と左の案内帯の下の選択欄（国旗とその言語の文字の言語名）で固定もできる。本体の確認ダイアログも同じ言語で出す。訳し漏れは型検査と `tests/unit/i18n.test.ts` で見つかる。言語の追加手順は [i18n.md](i18n.md)。Windows では `--lang=ja-JP`・`--lang=en-US` の画面の通し試験で確認。macOS・Linux では未確認。

## データ元

| データ元 | 状態 |
| --- | --- |
| Claude Code CLI / デスクトップ版のセッションログ | 対応（このPC の実ログで確認。デスクトップ版の `entrypoint: claude-desktop`） |
| Codex CLI / デスクトップ版 / IDE 拡張の rollout ログ（平文・zstd） | 対応（このPC の実ログで確認。`originator: Codex Desktop`、`source: vscode` を含む） |
| WSL 内のログ | 「WSL のログを探す」で検出して追加（`\\wsl.localhost\<distro>\home\*`）。このPC では未確認 |
| Codex ログ内の公式利用率 | 対応（実ログで確認） |
| Claude ステータスライン連携 | 実装済み・未確認（デスクトップ版で動くか不明。既存の statusLine と共存させる場合の Windows での呼び出しは未検証） |
| Codex App Server の利用率取得 | 未実装（別プロセスの App Server が既存セッションの通知を受け取れるか未検証） |
| Claude / ChatGPT の Web・モバイル利用 | 対象外（端末上のログに現れない） |
