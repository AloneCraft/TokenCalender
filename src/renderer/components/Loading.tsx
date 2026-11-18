// 読み込み中の表示（回る輪と文言）。読み上げ用に role="status" を付ける。

import { useT } from '../i18n/index.ts';

export function Loading({ block = false }: { block?: boolean }) {
  const t = useT();
  return (
    <div className={block ? 'loading block' : 'loading'} role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span>{t('common.loading')}</span>
    </div>
  );
}
