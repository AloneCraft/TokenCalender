import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { openDatabase, type Db } from '../../src/db/database.ts';
import { IngestEngine } from '../../src/ingest/engine.ts';
import { defaultSourceDefs, type SourceDef } from '../../src/ingest/discovery.ts';
import { claudeAssistant, claudeUser, codexMeta, codexRecord, codexTurnContext, resetOrdinal } from '../fixtures/builders.ts';
import { lines, makeTempDir, removeDir } from './helpers.ts';

let dir: string;
let db: Db;
let defs: SourceDef[];

function total(): number {
  return (db.prepare('SELECT COALESCE(SUM(total),0) t FROM usage_events').get() as { t: number }).t;
}

beforeEach(() => {
  dir = makeTempDir();
  const home = join(dir, 'home');
  mkdirSync(join(home, '.claude', 'projects', 'proj'), { recursive: true });
  mkdirSync(join(home, '.codex', 'sessions', '2026', '11', '10'), { recursive: true });
  mkdirSync(join(home, '.codex', 'archived_sessions'), { recursive: true });
  defs = defaultSourceDefs({}, home);
  db = openDatabase(join(dir, 'tc.sqlite'));
  resetOrdinal();
});

afterEach(() => {
  db.close();
  removeDir(dir);
});

const claudeFile = () => join(dir, 'home', '.claude', 'projects', 'proj', 'sess-1.jsonl');
const a = (id: string, out: number, stop: string | null = 'end_turn') =>
  claudeAssistant({ msgId: id, sessionId: 'sess-1', ts: '2026-11-10T01:00:00Z', stop, usage: { input: 1, output: out } });

describe('M: ファイルの変化への対応', () => {
  it('書き込み途中の末尾行は保留し、完成してから数える', async () => {
    const eng = new IngestEngine(db, () => defs);
    const line = a('m1', 9);
    writeFileSync(claudeFile(), claudeUser({ promptId: 'p1', sessionId: 'sess-1', ts: '2026-11-10T00:59:00Z' }) + '\n' + line.slice(0, 40));
    await eng.scanAll();
    expect(total()).toBe(0);
    appendFileSync(claudeFile(), line.slice(40) + '\n');
    await eng.processPath(claudeFile());
    expect(total()).toBe(10);
  });

  it('差分だけを読み、再走査・再起動しても合計が変わらない', async () => {
    writeFileSync(claudeFile(), lines(a('m1', 9)));
    await new IngestEngine(db, () => defs).scanAll();
    appendFileSync(claudeFile(), lines(a('m2', 19)));
    const eng2 = new IngestEngine(db, () => defs); // 再起動を想定
    await eng2.scanAll();
    await eng2.scanAll();
    expect(total()).toBe(30);
    const cur = db.prepare('SELECT offset, size FROM file_cursors').get() as { offset: number; size: number };
    expect(cur.offset).toBe(cur.size);
  });

  it('破損行は飛ばして数を記録し、続きを読む', async () => {
    writeFileSync(claudeFile(), lines(a('m1', 9), '{"type":"assistant","usage":{broken', a('m2', 19)));
    await new IngestEngine(db, () => defs).scanAll();
    expect(total()).toBe(30);
    expect((db.prepare('SELECT bad_lines FROM file_cursors').get() as { bad_lines: number }).bad_lines).toBe(1);
  });

  it('切り詰め・置き換えの後は最初から読み直し、重複は鍵で防ぐ', async () => {
    writeFileSync(claudeFile(), lines(a('m1', 9), a('m2', 19)));
    const eng = new IngestEngine(db, () => defs);
    await eng.scanAll();
    writeFileSync(claudeFile(), lines(a('m3', 4))); // 短い別内容に置き換え
    await eng.processPath(claudeFile());
    expect(total()).toBe(35); // 既に数えた m1, m2 は残り、m3 が加わる
  });

  it('ファイルを移動しても二重計上しない', async () => {
    writeFileSync(claudeFile(), lines(a('m1', 9)));
    const eng = new IngestEngine(db, () => defs);
    await eng.scanAll();
    renameSync(claudeFile(), join(dir, 'home', '.claude', 'projects', 'proj', 'moved.jsonl'));
    await eng.scanAll();
    expect(total()).toBe(10);
  });

  it('Codex: 平文と圧縮版、sessions と archived_sessions の同じログを二重計上しない', async () => {
    const ls = lines(
      codexMeta({ id: 'th1', ts: '2026-11-10T00:00:00Z' }),
      codexTurnContext({ ts: '2026-11-10T00:00:01Z', turnId: 't1', model: 'gpt-6.1-sol' }),
      codexRecord({ ts: '2026-11-10T00:00:02Z', threadId: 'th1', turnId: 't1', responseId: 'r1', usage: { input: 10, output: 1 }, thread: { input: 10, output: 1 } }),
    );
    const name = 'rollout-2026-11-10T00-00-00-th1.jsonl';
    const day = join(dir, 'home', '.codex', 'sessions', '2026', '11', '10');
    writeFileSync(join(day, name), ls);
    writeFileSync(join(day, name + '.zst'), zstdCompressSync(Buffer.from(ls)));
    writeFileSync(join(dir, 'home', '.codex', 'archived_sessions', name + '.zst'), zstdCompressSync(Buffer.from(ls)));
    await new IngestEngine(db, () => defs).scanAll();
    expect(total()).toBe(11);
  });

  it('圧縮版だけでも読め、変化がなければ読み直さない', async () => {
    const ls = lines(
      codexMeta({ id: 'th2', ts: '2026-11-10T00:00:00Z' }),
      codexTurnContext({ ts: '2026-11-10T00:00:01Z', turnId: 't1', model: 'gpt-6.1-sol' }),
      codexRecord({ ts: '2026-11-10T00:00:02Z', threadId: 'th2', turnId: 't1', responseId: 'r9', usage: { input: 30, output: 3 }, thread: { input: 30, output: 3 } }),
    );
    writeFileSync(join(dir, 'home', '.codex', 'archived_sessions', 'rollout-x-th2.jsonl.zst'), zstdCompressSync(Buffer.from(ls).subarray(0, ls.length - 1)));
    const eng = new IngestEngine(db, () => defs);
    await eng.scanAll();
    expect(total()).toBe(33);
    const r = await eng.processPath(join(dir, 'home', '.codex', 'archived_sessions', 'rollout-x-th2.jsonl.zst'));
    expect(r?.skipped).toBe(true);
  });

  it('読み取り処理の版が変わったら、古い版のイベントを消して読み直す', async () => {
    writeFileSync(claudeFile(), lines(a('m1', 9)));
    await new IngestEngine(db, () => defs).scanAll();
    // 古い版で誤った鍵のイベントが入っていた状況を作る
    db.prepare("UPDATE usage_events SET parser_version = 'claude-0', event_key = 'claude:old-wrong-key'").run();
    db.prepare("UPDATE file_cursors SET parser_version = 'claude-0'").run();
    await new IngestEngine(db, () => defs).scanAll();
    expect(total()).toBe(10);
    expect((db.prepare("SELECT COUNT(*) n FROM usage_events WHERE event_key = 'claude:old-wrong-key'").get() as { n: number }).n).toBe(0);
  });

  it('保存先が無い場合と、読めない場合を区別して記録する', async () => {
    await new IngestEngine(db, () => defs).scanAll();
    const rows = db.prepare('SELECT source_id, status FROM data_sources').all() as { status: string }[];
    const missing = db.prepare("SELECT COUNT(*) n FROM data_sources WHERE status = 'missing'").get() as { n: number };
    expect(rows.length).toBeGreaterThan(0);
    expect(missing.n).toBeGreaterThan(0); // ~/.config/claude/projects は作っていない
  });
});
