// 画面ごとの「読み込み中」を集める小さな入れ物。
// 読み込み中の表示を画面の中に出すと、出たり消えたりで配置が動く。
// そこで、左の案内帯のアイコンを回して知らせる（配置は動かない）。

import { useEffect, useSyncExternalStore } from 'react';

let busy: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

function set(page: string, on: boolean): void {
  if (busy.has(page) === on) return;
  const next = new Set(busy);
  if (on) next.add(page);
  else next.delete(page);
  busy = next;
  for (const l of listeners) l();
}

/** 画面が読み込み中の間 true を渡す。画面を離れたときは自動で解除する。 */
export function useBusy(page: string, on: boolean): void {
  useEffect(() => {
    set(page, on);
    return () => set(page, false);
  }, [page, on]);
}

export function useBusyPages(): ReadonlySet<string> {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => busy,
  );
}
