import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopApi, DesktopState } from './types.js';

const api: DesktopApi = {
  state: () => ipcRenderer.invoke('fingerprint:read'),
  refreshConnection: () => ipcRenderer.invoke('fingerprint:refresh-connection'),
  chooseCodex: () => ipcRenderer.invoke('fingerprint:choose-codex'),
  usePathCodex: () => ipcRenderer.invoke('fingerprint:use-path-codex'),
  refreshBank: () => ipcRenderer.invoke('fingerprint:refresh-bank'),
  start: (model) => ipcRenderer.invoke('fingerprint:start', model),
  cancel: () => ipcRenderer.invoke('fingerprint:cancel'),
  exportEvidence: () => ipcRenderer.invoke('fingerprint:export'),
  onState: (listener) => ipcRenderer.on('fingerprint:state', (_event, value: DesktopState) => listener(value)),
};

contextBridge.exposeInMainWorld('fingerprint', api);
