// 第三者ライセンス表示（THIRD_PARTY_NOTICES.md）を作る。
// 対象: package.json の dependencies と、その依存（配布物に入る実行時の部品）。Electron 本体は1行だけ記載する。
// 使い方: node scripts/gen-notices.cjs
const fs = require('fs');
const path = require('path');

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const seen = new Map();
function walk(name) {
  if (seen.has(name)) return;
  const dir = path.join('node_modules', name);
  let p;
  try {
    p = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch {
    return;
  }
  const lic = p.license || (p.licenses && p.licenses.map((l) => l.type).join(' OR ')) || 'UNKNOWN';
  const lf = fs.readdirSync(dir).find((f) => /^(license|licence|copying)/i.test(f));
  seen.set(name, {
    name,
    version: p.version,
    license: lic,
    file: lf ? fs.readFileSync(path.join(dir, lf), 'utf8') : null,
    repo: typeof p.repository === 'string' ? p.repository : p.repository && p.repository.url,
  });
  for (const d of Object.keys(p.dependencies || {})) walk(d);
}
for (const d of Object.keys(pkg.dependencies)) walk(d);
const electron = JSON.parse(fs.readFileSync('node_modules/electron/package.json', 'utf8'));

let out = '# 第三者ライセンス表示\n\n';
out += 'このアプリの配布物に含まれる第三者のソフトウェアです（実行時の部品。開発用の道具は含みません）。\n';
out += '`node scripts/gen-notices.cjs` で package.json の dependencies をたどって生成しています。\n\n';
out += `- Electron ${electron.version}（MIT）: Chromium と Node.js などを含みます。それらのライセンスは配布物の LICENSES.chromium.html にあります。\n`;
out += '- SQLite（Public Domain）: Node.js の node:sqlite として Electron に含まれます。\n\n';
for (const v of [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))) {
  out += `## ${v.name} ${v.version}\n\n- ライセンス: ${v.license}\n${v.repo ? `- リポジトリ: ${v.repo}\n` : ''}\n`;
  if (v.file) out += '```\n' + v.file.trim() + '\n```\n\n';
}
fs.writeFileSync('THIRD_PARTY_NOTICES.md', out);
console.log([...seen.values()].map((v) => `${v.name}@${v.version} ${v.license}`).join('\n'));
