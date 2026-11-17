import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type Db } from '../../src/db/database.ts';

/** 試験用の一時フォルダー。TOKEN_CALENDAR_TEST_TMP があればそこを使う（C ドライブを避けるため）。 */
export function makeTempDir(prefix = 'tc-test-'): string {
  const base = process.env.TOKEN_CALENDAR_TEST_TMP ?? (existsSync('D:/CodexTemp') ? 'D:/CodexTemp/TokenCalendar/test-tmp' : tmpdir());
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, prefix));
}

export function removeDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows で DB の WAL が閉じきっていない場合がある。試験結果には影響しない */
  }
}

export function memoryDb(): Db {
  return openDatabase(':memory:');
}

export function lines(...ls: string[]): string {
  return ls.join('\n') + '\n';
}
