import { app, BrowserWindow, clipboard, dialog, ipcMain } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ReferenceBank } from './bank.js';
import { emptyConnection, inspectCodex, publicError, type ReadyCodex } from './codex.js';
import { collect, makeDetection } from './collect.js';
import { CodexSelection } from './codex-selection.js';
import { collectClient, inspectClient, makeClientDetection, type ReadyClient } from './clients.js';
import { finishManual, inspectManual, makeManualDetection, saveManualReply } from './manual.js';
import { isManualSource, sources, type Connection, type DesktopState, type Detection, type Source } from './types.js';

const PRODUCT_NAME = 'OpenSosen Model Fingerprint';
const WINDOW_TITLE = 'OpenSosen 模型指纹';

app.setName(PRODUCT_NAME);
app.setAppUserModelId('OpenSosen.ModelFingerprint');

let window: BrowserWindow | null = null;
let source: Source = 'codex';
let connection: Connection = emptyConnection('checking');
let detection: Detection | null = null;
type Ready = { source: 'codex'; codex: ReadyCodex } | ReadyClient;
let ready: Ready | null = null;
let refreshing: { controller: AbortController; done: Promise<void> } | null = null;
let changingCodex: Promise<void> | null = null;
let active: { controller: AbortController; done: Promise<void> } | null = null;
let quitting = false;
const lifetime = new AbortController();
const bank = new ReferenceBank(join(app.getPath('userData'), 'reference'), publish);
const codexSelection = new CodexSelection(join(app.getPath('userData'), 'codex-selection.json'));

function state(): DesktopState {
  return {
    source, connection: { ...connection, configuredExecutablePath: source === 'codex' ? codexSelection.path : null },
    bank: bank.state, detection, changingCodex: changingCodex !== null,
  };
}

function publish() {
  if (window && !window.isDestroyed()) window.webContents.send('fingerprint:state', state());
}

async function inspect(target: Source, signal: AbortSignal): Promise<{ connection: Connection; ready: Ready | null }> {
  if (isManualSource(target)) return { connection: await inspectManual(target, signal), ready: null };
  if (target !== 'codex') return inspectClient(target, signal);
  if (codexSelection.loadError) return { connection: emptyConnection('error', codexSelection.loadError.message), ready: null };
  const result = await inspectCodex(signal, codexSelection.path);
  return { connection: result.connection, ready: result.ready ? { source: 'codex', codex: result.ready } : null };
}

function running() {
  return Boolean(active || detection?.status === 'running');
}

function refreshConnection() {
  if (running() || lifetime.signal.aborted) return;
  if (refreshing) return refreshing.done;
  if (source === 'codex' && codexSelection.loadError) {
    connection = emptyConnection('error', codexSelection.loadError.message);
    ready = null;
    publish();
    return;
  }
  connection = emptyConnection('checking');
  ready = null;
  const target = source;
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, lifetime.signal]);
  const done = inspect(target, signal).then((result) => {
    if (signal.aborted || source !== target) return;
    ready = result.ready;
    connection = result.connection;
  }).catch((error: unknown) => {
    if (signal.aborted || source !== target) return;
    ready = null;
    connection = emptyConnection('error', target === 'codex' ? publicError(error) : '无法检查此客户端。请刷新后重试。');
  }).finally(() => {
    if (refreshing?.controller !== controller) return;
    refreshing = null;
    publish();
  });
  refreshing = { controller, done };
  publish();
  return done;
}

function selectSource(value: unknown) {
  if (typeof value !== 'string' || !Object.hasOwn(sources, value) || source === value || running() ||
    changingCodex || lifetime.signal.aborted) return;
  refreshing?.controller.abort();
  refreshing = null;
  source = value as Source;
  return refreshConnection();
}

function changeCodex(usePath: boolean) {
  if (!window || source !== 'codex' || running() || refreshing || changingCodex || lifetime.signal.aborted) return;
  const owner = window;
  changingCodex = (async () => {
    let path: string | null = null;
    if (!usePath) {
      const result = await dialog.showOpenDialog(owner, {
        title: '选择 Codex 程序',
        defaultPath: codexSelection.path ?? connection.executablePath ?? undefined,
        filters: [{ name: 'Codex 可执行程序', extensions: ['exe'] }],
        properties: ['openFile'],
      });
      if (result.canceled || !result.filePaths[0] || lifetime.signal.aborted) return;
      path = result.filePaths[0];
    }
    await codexSelection.save(path);
    ready = null;
    detection = null;
    await refreshConnection();
  })().catch((error: unknown) => {
    connection = { ...connection, message: publicError(error) };
  }).finally(() => {
    changingCodex = null;
    publish();
  });
  publish();
  return changingCodex;
}

function markUnsent(run: Detection, cancelled: boolean, message: string | null) {
  run.status = cancelled ? 'cancelled' : 'failed';
  run.message = message;
  run.finishedAt = new Date().toISOString();
  for (const sample of run.samples) {
    if (sample.status === 'queued') {
      sample.status = cancelled ? 'cancelled' : 'failed';
      sample.error = message;
    }
  }
}

function collectOptions(signal: AbortSignal) {
  return { signal, update: publish, bank: () => bank.snapshot };
}

function start(target: unknown, modelId: unknown) {
  if (source !== target || lifetime.signal.aborted || running() || refreshing || changingCodex ||
    connection.state !== 'ready' || typeof modelId !== 'string') return false;
  if (isManualSource(source)) {
    detection = makeManualDetection(source, connection.version, modelId);
    publish();
    return true;
  }
  if (source === 'codex' && codexSelection.loadError) return false;
  const prior = ready;
  if (!prior || prior.source !== target) return false;
  const model = connection.models.find(({ id }) => id === modelId);
  if (!model) return false;

  const run = detection = prior.source === 'codex' ? makeDetection(prior.codex, model) : makeClientDetection(prior, model);
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, lifetime.signal]);
  const done = (async () => {
    const inspected = await inspect(prior.source, signal);
    if (signal.aborted) { markUnsent(run, true, null); return; }
    const current = ready = inspected.ready;
    connection = inspected.connection;
    if (prior.source === 'codex') run.diagnostics = inspected.connection.diagnostics;
    const currentModel = connection.models.find(({ id }) => id === modelId);
    if (!current || !currentModel || current.source !== prior.source ||
      inspected.connection.executablePath !== run.executablePath || inspected.connection.version !== run.clientVersion ||
      (currentModel.account ?? connection.account) !== run.account || currentModel.effort !== model.effort ||
      JSON.stringify(currentModel.route ?? connection.route) !== JSON.stringify(run.route)) {
      markUnsent(run, false, inspected.connection.message ?? '客户端、登录、模型或路由已变化，请核对界面后重新开始。');
      return;
    }
    if (current.source === 'codex' && prior.source === 'codex') {
      if (current.codex.executable !== prior.codex.executable ||
        current.codex.binaryIdentity !== prior.codex.binaryIdentity || current.codex.accountBinding !== prior.codex.accountBinding ||
        JSON.stringify(current.codex.routeConfig) !== JSON.stringify(prior.codex.routeConfig)) {
        markUnsent(run, false, 'Codex 程序、托管账号或路由已变化，请核对界面后重新开始。');
        return;
      }
      await collect(current.codex, currentModel, run, collectOptions(signal));
    } else if (current.source !== 'codex') {
      await collectClient(current, currentModel, run, collectOptions(signal));
    }
  })().catch((error: unknown) => {
    const message = prior.source === 'codex' ? publicError(error) : '无法完成客户端采样，已收到的原始回复仍可导出。';
    markUnsent(run, signal.aborted, signal.aborted ? null : message);
  }).finally(() => {
    active = null;
    publish();
  });
  active = { controller, done };
  publish();
  return true;
}

function copyChallenge(index: unknown) {
  if (detection?.mode !== 'manual' || detection.status !== 'running' || typeof index !== 'number' || !Number.isInteger(index)) return false;
  const sample = detection.samples[index];
  if (!sample) return false;
  clipboard.writeText(sample.prompt);
  return true;
}

function saveReply(index: unknown, text: unknown) {
  if (!detection || !saveManualReply(detection, index, text)) return false;
  publish();
  return true;
}

function cancel() {
  active?.controller.abort();
  if (detection?.mode === 'manual') finishManual(detection, collectOptions(AbortSignal.abort()));
}

async function exportEvidence() {
  const current = detection;
  if (!current || current.status === 'running') return { path: null };
  const name = current.model.replace(/[^a-z0-9._-]+/gi, '-').slice(0, 70);
  const dir = join(app.getPath('documents'), PRODUCT_NAME, '证据');
  const path = join(dir, `opensosen-model-fingerprint-${current.source}-${name}-${current.startedAt.slice(0, 10)}-${current.id.slice(0, 8)}.json`);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(path, JSON.stringify({
      format: 'opensosen-model-fingerprint-v2',
      responseModel: null,
      routeBasis: current.routeBasis,
      responseTransport: current.transport,
      detection: current,
    }, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
    return { path };
  } catch {
    return { path: null };
  }
}

function registerIpc() {
  const handlers = {
    'fingerprint:read': state,
    'fingerprint:select-source': selectSource,
    'fingerprint:refresh-connection': () => { if (!changingCodex) return refreshConnection(); },
    'fingerprint:choose-codex': () => changeCodex(false),
    'fingerprint:use-path-codex': () => changeCodex(true),
    'fingerprint:refresh-bank': () => bank.refresh(),
    'fingerprint:start': start,
    'fingerprint:copy-challenge': copyChallenge,
    'fingerprint:save-reply': saveReply,
    'fingerprint:score-replies': () => Boolean(detection && finishManual(detection, collectOptions(lifetime.signal))),
    'fingerprint:cancel': cancel,
    'fingerprint:export': exportEvidence,
  };
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, (event, arg?: unknown, extra?: unknown) => {
      if (!window || event.sender !== window.webContents || event.senderFrame !== event.sender.mainFrame) return;
      return handler(arg, extra);
    });
  }
}

function createWindow() {
  const current = new BrowserWindow({
    title: WINDOW_TITLE, width: 1110, height: 850,
    minWidth: 620, minHeight: 540, backgroundColor: '#f1f4f7', show: false,
    webPreferences: { preload: join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false },
  });
  window = current;
  current.removeMenu();
  current.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  current.webContents.on('will-navigate', (event) => event.preventDefault());
  current.webContents.session.setPermissionRequestHandler((_, __, answer) => answer(false));
  current.once('ready-to-show', () => current.show());
  current.on('closed', () => { window = null; });
  void current.loadFile(join(__dirname, 'index.html'));
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (event) => {
    lifetime.abort();
    if (quitting || (!refreshing && !active && !changingCodex)) return;
    event.preventDefault();
    quitting = true;
    void Promise.allSettled([refreshing?.done, active?.done, changingCodex]).then(() => app.quit());
  });
  void app.whenReady().then(async () => {
    try { await codexSelection.load(); }
    catch (error) { connection = emptyConnection('error', publicError(error)); }
    registerIpc();
    createWindow();
    void refreshConnection();
    void bank.refresh();
  });
}
