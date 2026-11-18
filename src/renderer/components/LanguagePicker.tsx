// 表示言語の選択欄。国旗と、その言語の文字で書いた言語名を並べる。
// ふつうの select では選択肢に絵を出せないため、listbox の作法（WAI-ARIA）に沿った自前の選択欄にしている。
// キーボード: 開く（↓・Enter・Space）、移動（↑↓・Home・End）、決定（Enter・Space）、閉じる（Esc・Tab）。

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { LANGUAGES, languageOf, type LangCode, type LanguageSetting } from '../../shared/i18n/languages.ts';
import { Flag } from '../i18n/flags.tsx';
import { resolveLang, useT } from '../i18n/index.ts';

interface Option {
  value: LanguageSetting;
  /** 国旗と言語名に使う言語（system なら OS の言語から選んだもの） */
  lang: LangCode;
}

export function LanguagePicker({
  value,
  onChange,
  compact = false,
  id,
}: {
  value: LanguageSetting;
  onChange: (v: LanguageSetting) => void;
  /** 案内帯の下に置く小さい形（国旗と言語コードだけ）。一覧は右上へ開く */
  compact?: boolean;
  id?: string;
}) {
  const t = useT();
  const autoId = useId();
  const baseId = id ?? `lang-${autoId}`;
  const osLang = resolveLang('system');
  const options: Option[] = [{ value: 'system', lang: osLang }, ...LANGUAGES.map((l) => ({ value: l.code as LangCode, lang: l.code as LangCode }))];
  const selectedIndex = Math.max(0, options.findIndex((o) => o.value === value));
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(selectedIndex);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setActive(selectedIndex);
    listRef.current?.focus();
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
    // 開いたときだけ選択中の位置に合わせる（selectedIndex が変わるのは選んだ後で、そのときは閉じている）
  }, [open]);

  // 一覧が長くなったとき、キーボードで動かした項目が見える位置まで一覧を動かす
  useEffect(() => {
    if (open) document.getElementById(`${baseId}-opt-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active, baseId]);

  const choose = (i: number) => {
    const o = options[i];
    if (!o) return;
    setOpen(false);
    buttonRef.current?.focus();
    if (o.value !== value) onChange(o.value);
  };

  const onButtonKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setOpen(true);
    }
  };

  const onListKey = (e: KeyboardEvent) => {
    const last = options.length - 1;
    if (e.key === 'ArrowDown') setActive((a) => Math.min(last, a + 1));
    else if (e.key === 'ArrowUp') setActive((a) => Math.max(0, a - 1));
    else if (e.key === 'Home') setActive(0);
    else if (e.key === 'End') setActive(last);
    else if (e.key === 'Enter' || e.key === ' ') choose(active);
    else if (e.key === 'Escape') {
      setOpen(false);
      buttonRef.current?.focus();
    } else if (e.key === 'Tab') setOpen(false);
    else return;
    if (e.key !== 'Tab') e.preventDefault();
  };

  const label = (o: Option) => {
    const def = languageOf(o.lang);
    if (o.value === 'system') return <span>{t('lang.systemCurrent', { name: def.nativeName })}</span>;
    return (
      <>
        <span lang={def.code}>{def.nativeName}</span>
        {def.englishName !== def.nativeName && (
          <span className="faint" lang="en">
            {def.englishName}
          </span>
        )}
      </>
    );
  };

  const current = options[selectedIndex]!;
  const currentDef = languageOf(current.lang);
  return (
    <div ref={rootRef} className={`lang-picker${compact ? ' compact' : ''}`}>
      <button
        ref={buttonRef}
        id={`${baseId}-button`}
        type="button"
        className="lang-button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${baseId}-list`}
        aria-label={compact ? `${t('lang.label')}: ${currentDef.nativeName}` : undefined}
        title={compact ? `${t('lang.label')}: ${currentDef.nativeName}` : undefined}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onButtonKey}
      >
        <Flag id={currentDef.flag} size={compact ? 14 : 16} />
        {compact ? (
          <span className="lang-code" title="狭い案内帯に収まるよう言語の部分だけ（zh-Hans → ZH）。区別は国旗が担う">{currentDef.code.split('-')[0]!.toUpperCase()}</span>
        ) : (
          <span className="lang-current">{current.value === 'system' ? t('lang.systemCurrent', { name: currentDef.nativeName }) : <span lang={currentDef.code}>{currentDef.nativeName}</span>}</span>
        )}
        <span className="lang-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <ul
          ref={listRef}
          id={`${baseId}-list`}
          role="listbox"
          tabIndex={-1}
          aria-label={t('lang.label')}
          aria-activedescendant={`${baseId}-opt-${active}`}
          className="lang-list"
          onKeyDown={onListKey}
        >
          {options.map((o, i) => (
            <li
              key={o.value}
              id={`${baseId}-opt-${i}`}
              role="option"
              aria-selected={i === selectedIndex}
              data-value={o.value}
              className={`lang-option${i === active ? ' active' : ''}${o.value === 'system' ? ' system' : ''}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(i)}
            >
              <Flag id={languageOf(o.lang).flag} size={16} />
              {label(o)}
              {i === selectedIndex && (
                <span className="lang-check" aria-hidden="true">
                  ✓
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
