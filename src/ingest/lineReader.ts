// JSONL を指定位置から1行ずつ読む。
// - 改行で終わっていない末尾は「書き込み途中」とみなして読まない（次回に持ち越す）。
// - zstd 圧縮ファイルは完成済みとみなし、最初から最後まで展開して読む。

import { open } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createZstdDecompress } from 'node:zlib';

const CHUNK = 1 << 20; // 1MB
const NL = 0x0a;

export type LineHandler = (line: string, offset: number) => void | Promise<void>;

export interface ReadResult {
  /** 次回読み始める位置（最後に処理した改行の直後） */
  endOffset: number;
  lines: number;
}

function decodeLine(buf: Buffer): string {
  let end = buf.length;
  if (end > 0 && buf[end - 1] === 0x0d) end--; // CRLF
  return buf.toString('utf8', 0, end);
}

/**
 * 平文の JSONL を offset から読む。onBatchBoundary は一定量ごとに呼ばれ、
 * 呼び出し側はそこで保存と読み取り位置の確定を行える（その時点の endOffset を渡す）。
 */
export async function readPlainLines(
  path: string,
  offset: number,
  onLine: LineHandler,
  onBatchBoundary?: (endOffset: number) => void | Promise<void>,
  batchBytes = 8 * CHUNK,
): Promise<ReadResult> {
  const fh = await open(path, 'r');
  try {
    let pos = offset;
    let pending: Buffer[] = [];
    let pendingLen = 0;
    let pendingStart = offset;
    let lastBoundary = offset;
    let lines = 0;
    let endOffset = offset;
    const buf = Buffer.allocUnsafe(CHUNK);
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, CHUNK, pos);
      if (bytesRead === 0) break;
      let start = 0;
      for (let i = 0; i < bytesRead; i++) {
        if (buf[i] !== NL) continue;
        const piece = buf.subarray(start, i);
        let lineBuf: Buffer;
        if (pendingLen > 0) {
          pending.push(Buffer.from(piece));
          lineBuf = Buffer.concat(pending, pendingLen + piece.length);
          pending = [];
          pendingLen = 0;
        } else {
          lineBuf = piece;
        }
        const lineStart = pendingStart;
        endOffset = pos + i + 1;
        pendingStart = endOffset;
        start = i + 1;
        if (lineBuf.length > 0) {
          await onLine(decodeLine(lineBuf), lineStart);
          lines++;
        }
        if (onBatchBoundary && endOffset - lastBoundary >= batchBytes) {
          lastBoundary = endOffset;
          await onBatchBoundary(endOffset);
        }
      }
      if (start < bytesRead) {
        const rest = Buffer.from(buf.subarray(start, bytesRead));
        pending.push(rest);
        pendingLen += rest.length;
      }
      pos += bytesRead;
    }
    return { endOffset, lines };
  } finally {
    await fh.close();
  }
}

/** zstd 圧縮の JSONL を最初から読む。最後の行は改行が無くても完成した行として扱う。 */
export async function readZstdLines(path: string, onLine: LineHandler): Promise<ReadResult> {
  const stream = createReadStream(path).pipe(createZstdDecompress());
  let pending: Buffer[] = [];
  let pendingLen = 0;
  let offset = 0;
  let lines = 0;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    let start = 0;
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] !== NL) continue;
      const piece = chunk.subarray(start, i);
      const lineBuf = pendingLen > 0 ? Buffer.concat([...pending, piece], pendingLen + piece.length) : piece;
      pending = [];
      pendingLen = 0;
      const lineStart = offset;
      offset += lineBuf.length + 1;
      start = i + 1;
      if (lineBuf.length > 0) {
        await onLine(decodeLine(lineBuf), lineStart);
        lines++;
      }
    }
    if (start < chunk.length) {
      const rest = Buffer.from(chunk.subarray(start));
      pending.push(rest);
      pendingLen += rest.length;
    }
  }
  if (pendingLen > 0) {
    const lineBuf = Buffer.concat(pending, pendingLen);
    await onLine(decodeLine(lineBuf), offset);
    offset += lineBuf.length;
    lines++;
  }
  return { endOffset: offset, lines };
}

/**
 * ファイル先頭の指紋（"長さ:ハッシュ"）。置き換え（別内容の同名ファイル）を見分けるのに使う。
 * 追記で変わらないよう、読み終えた範囲（limit）までの先頭だけを対象にする。
 */
export async function headFingerprint(path: string, limit: number, bytes = 1024): Promise<string | null> {
  const n = Math.min(bytes, limit);
  if (n <= 0) return null;
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    if (bytesRead < n) return `${n}:short`;
    const { createHash } = await import('node:crypto');
    return `${n}:` + createHash('sha256').update(buf).digest('hex').slice(0, 24);
  } finally {
    await fh.close();
  }
}

/** 保存済みの指紋と同じ長さで現在の先頭を計算し直し、一致するかを返す。 */
export async function sameHead(path: string, stored: string | null): Promise<boolean> {
  if (!stored) return true;
  const n = Number(stored.split(':')[0]);
  if (!Number.isFinite(n) || n <= 0) return true;
  return (await headFingerprint(path, n, n)) === stored;
}
