/** 行の配列を CSV（RFC 4180 形式、UTF-8 BOM つき）にする。 */
export function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '﻿';
  const cols = Object.keys(rows[0]!);
  const esc = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    const s = typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v);
    // 表計算ソフトでの数式実行を防ぐ
    const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
    return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return '﻿' + [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\r\n') + '\r\n';
}
