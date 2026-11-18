// 取り込みスレッドと問い合わせスレッドの起動・通信。

import { Worker } from 'node:worker_threads';
import ingestWorkerPath from '../ingest/worker.ts?modulePath';
import queryWorkerPath from '../query/worker.ts?modulePath';
import type { IngestStatus } from '../shared/api.ts';

export class WorkerHub {
  private ingest: Worker | null = null;
  private query: Worker | null = null;
  private seq = 0;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  progress: IngestStatus = {
    phase: 'idle',
    filesTotal: 0,
    filesDone: 0,
    bytesTotal: 0,
    bytesDone: 0,
    eventsInserted: 0,
    eventsUpdated: 0,
    startedAt: null,
    finishedAt: null,
    lastChangeAt: null,
    errors: 0,
  };

  private readonly opts: {
    dbPath: string;
    demoDbPath: string;
    bridgeDir: string;
    onChanged: (at: number) => void;
    onProgress: (p: IngestStatus) => void;
    onError: (msg: string) => void;
  };

  constructor(opts: WorkerHub['opts']) {
    this.opts = opts;
  }

  start(): void {
    this.startQuery();
    this.startIngest();
  }

  private startQuery(): void {
    this.query = new Worker(queryWorkerPath, { workerData: { dbPath: this.opts.dbPath, demoDbPath: this.opts.demoDbPath } });
    this.query.on('message', (m: { id: number; result?: unknown; error?: string }) => {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error !== undefined) p.reject(new Error(m.error));
      else p.resolve(m.result);
    });
    // 問い合わせスレッドが落ちたら、待っている呼び出しを失敗として返す（画面が読み込み中のまま止まらないように）
    const failAll = (reason: string): void => {
      for (const [id, p] of this.pending) {
        this.pending.delete(id);
        p.reject(new Error(reason));
      }
    };
    this.query.on('error', (e) => {
      this.opts.onError(String(e));
      failAll(String(e));
    });
    this.query.on('exit', (code) => failAll(`query worker exited (${code})`));
  }

  private startIngest(): void {
    this.ingest = new Worker(ingestWorkerPath, { workerData: { dbPath: this.opts.dbPath, bridgeDir: this.opts.bridgeDir } });
    this.ingest.on('message', (m: { type: string; at?: number; progress?: IngestStatus; message?: string }) => {
      if (m.type === 'changed') this.opts.onChanged(m.at ?? Date.now());
      else if (m.type === 'progress' && m.progress) {
        this.progress = m.progress;
        this.opts.onProgress(m.progress);
      } else if (m.type === 'error') this.opts.onError(m.message ?? 'ingest error');
    });
    this.ingest.on('error', (e) => this.opts.onError(String(e)));
  }

  call<T>(method: string, params: unknown): Promise<T> {
    if (!this.query) return Promise.reject(new Error('query worker is not running'));
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.query!.postMessage({ id, method, params });
    });
  }

  rescan(): void {
    this.ingest?.postMessage({ type: 'rescan' });
  }

  async stop(): Promise<void> {
    await this.call('__close', null).catch(() => undefined);
    await Promise.all([this.ingest?.terminate(), this.query?.terminate()]);
    this.ingest = null;
    this.query = null;
  }

  async restart(): Promise<void> {
    await this.stop();
    this.start();
  }
}
