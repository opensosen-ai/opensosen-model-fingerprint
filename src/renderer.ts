import type { AccountMode, BankState, DesktopApi, DesktopState, Detection, SampleEvidence } from './types.js';

declare global {
  interface Window { fingerprint: DesktopApi }
}

const api = window.fingerprint;
const get = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const model = get<HTMLSelectElement>('model');
const start = get<HTMLButtonElement>('start');
const cancel = get<HTMLButtonElement>('cancel');
const refresh = get<HTMLButtonElement>('refresh');
const chooseCodex = get<HTMLButtonElement>('choose-codex');
const usePathCodex = get<HTMLButtonElement>('use-path-codex');
const exportButton = get<HTMLButtonElement>('export');
const refreshBank = get<HTMLButtonElement>('refresh-bank');
const sampleList = get('samples');
const resultBody = get('result-body');
const evidence = get('evidence');
let modelListKey = '';
let resultKey = '';
let starting = false;
let cancelling = false;
let exporting = false;
let exportedRun: string | null = null;
let last: DesktopState | null = null;

const accountText: Record<AccountMode, string> = {
  chatgpt: 'ChatGPT 账号', apiKey: 'API Key', signedOut: '未登录', other: '其他登录方式',
};
const statusText: Record<SampleEvidence['status'], string> = {
  queued: '待采集', running: '采集中', received: '已收到', failed: '失败', cancelled: '已取消', timeout: '超时',
};

function make<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function explain(id: string, message: string | null) {
  const element = get(id);
  element.hidden = !message;
  element.textContent = message;
}

const progressRows = Array.from({ length: 3 }, (_, index) => {
  const row = make('li');
  const label = make('span', `样本 ${index + 1}`, 'sample-label');
  const status = make('span', '待检测', 'sample-status');
  const count = make('span', '—', 'sample-count mono');
  row.append(label, status, count);
  sampleList.append(row);
  return { row, status, count };
});

function renderProgress(run: Detection | null) {
  const received = run?.samples.filter((sample) => sample.status === 'received').length ?? 0;
  get('progress-count').textContent = `${received} / 3 已收到`;
  for (const [index, row] of progressRows.entries()) {
    const sample = run?.samples[index];
    row.row.dataset.status = sample?.status ?? 'queued';
    row.status.textContent = sample ? statusText[sample.status] : '待检测';
    row.count.textContent = sample ? `${sample.count} / ${sample.expected}` : '—';
    row.count.title = sample ? '最长有效数字段的数量 / 挑战要求数量' : '';
  }
}

const results: Record<Detection['status'], string> = {
  running: '正在采集三个独立样本',
  scored: '参考库相似度排名',
  partial: '参考库相似度排名（部分样本）',
  unscorable: '有效数字不足，未生成排名',
  not_model: '序列特征不适合与参考库比较',
  failed: '检测失败，未生成排名',
  cancelled: '检测已取消，未生成排名',
  timeout: '采样超时，未生成排名',
  bankUnavailable: '已收到回复，参考库暂不可用',
};

function renderResult(run: Detection | null) {
  const key = `${run?.id ?? ''}:${run?.status ?? ''}`;
  if (key === resultKey) return;
  resultKey = key;
  evidence.replaceChildren();
  if (!run) {
    resultBody.replaceChildren(make('p', '检测完成后在这里查看相似候选和原始回复。', 'empty'));
    return;
  }

  resultBody.replaceChildren(make('h3', results[run.status], 'result-heading'));
  if (run.status === 'running') return;
  if (run.message) resultBody.append(make('p', run.message, 'callout'));
  if (run.analysis) {
    const used = run.analysis.used_outputs;
    resultBody.append(make('p', `评分使用 ${used} / 3 个样本。相似度只反映本次输出与库中候选的接近程度。`, 'fine-print'));
    if (run.analysis.results.length) {
      const table = make('table');
      const headers = make('tr');
      for (const column of ['参考模型', '家族', '排名分']) {
        const header = make('th', column);
        header.scope = 'col';
        headers.append(header);
      }
      table.createTHead().append(headers);
      const rows = table.createTBody();
      for (const candidate of run.analysis.results.slice(0, 8)) {
        const row = rows.insertRow();
        row.insertCell().textContent = candidate.display_name || candidate.model;
        row.insertCell().textContent = candidate.family_name || candidate.family;
        const score = row.insertCell();
        score.textContent = candidate.score.toFixed(4);
        score.className = 'mono';
      }
      resultBody.append(table);
    }
  }

  const metadata = make('div', undefined, 'evidence-meta');
  metadata.append(make('span', `请求 ${run.model}${run.effort ? ` · ${run.effort}` : ''}`));
  metadata.append(make('span', `${accountText[run.account]} · ${run.route.provider} · ${run.route.origin}`));
  metadata.append(make('span', `Codex ${run.codexVersion} · ${run.executablePath} · SDK ${run.sdk}`));
  if (run.bank) metadata.append(make('span', `快照 ${date(run.bank.builtAt)} · ${run.bank.sha256.slice(0, 12)}`));
  evidence.append(metadata, make('p', 'Codex 采样事件未报告实际推理模型。路由记录来自本机提供方与本次进程配置。', 'fine-print'));
  if (run.route.kind === 'chatgpt') {
    const received = run.samples.some((sample) => sample.status === 'received');
    evidence.append(make('p', received ? '官方账号地址已收到 Codex 的完整回复。' : '官方账号地址未收到完整回复，账号通道实测未通过。', 'fine-print'));
  }

  for (const [index, sample] of run.samples.entries()) {
    const detail = make('details');
    detail.append(make('summary', `样本 ${index + 1} · ${statusText[sample.status]} · ${sample.count} / ${sample.expected}`));
    const contents = make('div', undefined, 'sample-evidence');
    if (sample.error) contents.append(make('p', sample.error, 'callout'));
    if (sample.threadId) contents.append(make('p', `Codex 会话 ${sample.threadId}`, 'fine-print'));
    if (sample.durationMs !== null) contents.append(make('p', `耗时 ${(sample.durationMs / 1000).toFixed(1)} 秒`, 'fine-print'));
    contents.append(make('h4', '原始回复'), make('pre', sample.raw || '暂无可用的助手文本。'));
    contents.append(make('h4', '数字挑战'), make('pre', sample.prompt));
    detail.append(contents);
    evidence.append(detail);
  }
}

function date(value: string) {
  const time = new Date(value);
  return Number.isNaN(time.valueOf()) ? value : time.toLocaleString('zh-CN', { hour12: false });
}

function renderBank(bank: BankState) {
  refreshBank.disabled = bank.state === 'checking';
  get('bank-status').textContent = bank.info
    ? `${bank.info.modelCount === null ? '' : `${bank.info.modelCount} 个候选 · `}${date(bank.info.builtAt)}${bank.state === 'checking' ? ' · 检查中' : bank.message ? ` · ${bank.message}` : ''}`
    : bank.message ?? '正在检查并加载参考库…';
}

function render(state: DesktopState) {
  last = state;
  const { connection, detection } = state;
  const running = detection?.status === 'running';
  if (!running) cancelling = false;
  const badge = get('connection-badge');
  badge.dataset.tone = connection.state === 'ready' ? 'good' : connection.state === 'checking' ? 'pending' : 'bad';
  badge.textContent = connection.state === 'ready' ? `Codex ${connection.version}` : connection.state === 'checking' ? '正在连接 Codex' : 'Codex 不可用';
  get('account').textContent = connection.account ? accountText[connection.account] : connection.state === 'checking' ? '读取中…' : '未确认';
  const route = connection.route;
  get('route').textContent = route ? (route.kind === 'chatgpt' ? '官方 ChatGPT 账号地址' : route.kind === 'openai-api' ? 'OpenAI API' : `自定义路由 · ${route.provider}`) : '未确认';
  const routeMessage = route?.kind === 'chatgpt'
    ? `采样指定 ${route.origin}。账号通道需通过真实采样验证。${connection.configuredProvider !== 'openai' ? ` Codex 默认提供方为 ${connection.configuredProvider}。` : ''}`
    : route?.kind === 'custom' ? `网关 ${route.origin} · 复用 Codex 托管的 API Key 和网关地址。` : null;
  explain('route-detail', routeMessage);
  explain('connection-message', connection.message);
  get('codex-mode').textContent = connection.configuredExecutablePath ? '手动指定' : '自动查找（PATH）';
  get('codex-path').textContent = connection.executablePath ?? connection.configuredExecutablePath
    ?? (connection.state === 'checking' ? '正在查找…' : '未找到 Codex 程序');
  get('codex-path').title = connection.executablePath ?? connection.configuredExecutablePath ?? '';

  const key = JSON.stringify(connection.models);
  if (key !== modelListKey) {
    modelListKey = key;
    const selected = model.value;
    model.replaceChildren(...connection.models.map((entry) => {
      const option = make('option', entry.title === entry.id ? entry.id : `${entry.title} · ${entry.id}`);
      option.value = entry.id;
      return option;
    }));
    if (connection.models.some((entry) => entry.id === selected)) model.value = selected;
    else if (connection.models.length) model.value = (connection.models.find((entry) => entry.isDefault) ?? connection.models[0]).id;
  }
  if (!connection.models.length) {
    const option = make('option', connection.state === 'checking' ? '正在读取列表…' : '暂无可选模型');
    option.value = '';
    model.replaceChildren(option);
  }

  const ready = connection.state === 'ready' && !running && !starting && !state.changingCodex;
  model.disabled = !ready;
  start.disabled = !ready;
  start.hidden = Boolean(running);
  cancel.hidden = !running;
  cancel.disabled = cancelling;
  cancel.textContent = cancelling ? '正在取消…' : '取消';
  const busy = Boolean(running || starting || state.changingCodex || connection.state === 'checking');
  refresh.disabled = busy;
  chooseCodex.disabled = busy;
  usePathCodex.disabled = busy || (connection.state !== 'error' && !connection.configuredExecutablePath);
  exportButton.disabled = !detection || running || exporting || exportedRun === detection.id;
  renderProgress(detection);
  renderResult(detection);
  renderBank(state.bank);
}

get<HTMLFormElement>('detect-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const selected = model.value;
  if (!selected || start.disabled || !last) return;
  explain('export-message', null);
  starting = true;
  render(last);
  try { await api.start(selected); }
  finally { starting = false; if (last) render(last); }
});
cancel.addEventListener('click', () => {
  cancelling = true;
  if (last) render(last);
  void api.cancel();
});
refresh.addEventListener('click', () => { void api.refreshConnection(); });
chooseCodex.addEventListener('click', () => { void api.chooseCodex(); });
usePathCodex.addEventListener('click', () => { void api.usePathCodex(); });
refreshBank.addEventListener('click', () => { void api.refreshBank(); });
exportButton.addEventListener('click', async () => {
  exporting = true;
  exportButton.disabled = true;
  try {
    const id = last?.detection?.id;
    const result = await api.exportEvidence();
    if (id && result.path) exportedRun = id;
    if (id === last?.detection?.id) explain('export-message', result.path ? `已保存 ${result.path}` : '保存失败，请检查文档文件夹。');
  } finally {
    exporting = false;
    if (last) render(last);
  }
});
api.onState(render);
void api.state().then(render);
