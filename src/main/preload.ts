// 画面へ公開する最小限の API。Node の機能は公開しない。

import { contextBridge, ipcRenderer } from 'electron';
import type { TokenCalendarApi } from '../shared/api.ts';

const call =
  (name: string) =>
  (params?: unknown): Promise<never> =>
    ipcRenderer.invoke(`tc:${name}`, params) as Promise<never>;

const api: TokenCalendarApi = {
  getStatus: call('getStatus'),
  getSettings: call('getSettings'),
  setSettings: call('setSettings'),
  calendar: call('calendar'),
  timeline: call('timeline'),
  dayDetail: call('dayDetail'),
  recent: call('recent'),
  currentChats: call('currentChats'),
  planCompare: call('planCompare'),
  quotaOverview: call('quotaOverview'),
  estimate: call('estimate'),
  analysis: call('analysis'),
  planOverview: call('planOverview'),
  rates: call('rates'),
  simulate: call('simulate'),
  addManualObservation: call('addManualObservation'),
  deleteManualObservation: (id: number) => ipcRenderer.invoke('tc:deleteManualObservation', { id }),
  listManualObservations: call('listManualObservations'),
  updateSource: call('updateSource'),
  addSource: call('addSource'),
  pickFolder: call('pickFolder'),
  rescan: call('rescan'),
  detectWsl: call('detectWsl'),
  exportData: call('exportData'),
  importData: call('importData'),
  deleteAppData: call('deleteAppData'),
  bridgePreview: call('bridgePreview'),
  bridgeInstall: call('bridgeInstall'),
  bridgeUninstall: call('bridgeUninstall'),
  openExternal: (url: string) => ipcRenderer.invoke('tc:openExternal', url),
  onDataChanged(cb) {
    const h = (_e: unknown, info: { at: number }) => cb(info);
    ipcRenderer.on('tc:changed', h);
    return () => ipcRenderer.removeListener('tc:changed', h);
  },
  onIngestProgress(cb) {
    const h = (_e: unknown, p: Parameters<typeof cb>[0]) => cb(p);
    ipcRenderer.on('tc:progress', h);
    return () => ipcRenderer.removeListener('tc:progress', h);
  },
};

contextBridge.exposeInMainWorld('tokenCalendar', api);
