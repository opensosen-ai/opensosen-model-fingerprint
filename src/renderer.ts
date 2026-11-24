import { isManualSource, sources, type AccountMode, type BankState, type CodexProbeDiagnostic, type DesktopApi, type DesktopState, type Detection, type SampleEvidence, type Source } from './types.js';

declare global {
  interface Window { fingerprint: DesktopApi }
}

const api = window.fingerprint;
const get = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const sourceSelect = get<HTMLSelectElement>('source');
const model = get<HTMLSelectElement>('model');
const manualModel = get<HTMLInputElement>('manual-model');
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
const manualReplies = get('manual-replies');
const scoreReplies = get<HTMLButtonElement>('score-replies');
let modelListKey = '';
let resultKey = '';
let starting = false;
let cancelling = false;
let exporting = false;
let exportedRun: string | null = null;
let last: DesktopState | null = null;
let manualRunId: string | null = null;

const accountText: Record<AccountMode, string> = {
  chatgpt: 'ChatGPT 账号', apiKey: 'API Key', signedOut: '未登录', other: '其他登录方式',
  claude: 'Claude 账号', oauth: 'OAuth 令牌', clientConfigured: '客户端配置，登录类型未核验',
};
const statusText: Record<SampleEvidence['status'], string> = {
  queued: '待采集', running: '采集中', received: '已收到', failed: '失败', cancelled: '已取消', timeout: '超时', skipped: '未提交',
};
const probeContext: Record<CodexProbeDiagnostic['context'], string> = {
  configured: '当前配置', official: '官方上下文', 'storage-file': '文件存储', 'storage-keyring': '系统凭据库',
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

for (const [id, entry] of Object.entries(sources)) {
  const option = make('option', entry.mode === 'manual' ? `${entry.title}（手动）` : entry.title);
  option.value = id;
  sourceSelect.append(option);
}

function renderManual(run: Detection | null) {
  const manual = run?.mode === 'manual' && run.status === 'running' ? run : null;
  get('manual-samples').hidden = !manual;
  scoreReplies.disabled = !manual?.samples.some((sample) => sample.status === 'received');
  if ((manual?.id ?? null) === manualRunId) return;
  manualRunId = manual?.id ?? null;
  manualReplies.replaceChildren();
  if (!manual) return;
  for (const [index, sample] of manual.samples.entries()) {
    const detail = make('details');
    detail.open = index === 0;
    detail.append(make('summary', `挑战 ${index + 1}`));
    const contents = make('div', undefined, 'sample-evidence');
    const prompt = make('pre', sample.prompt);
    const copy = make('button', '复制挑战', 'secondary');
    copy.type = 'button';
    const label = make('label', '原始回复');
    const reply = make('textarea');
    label.htmlFor = reply.id = `manual-reply-${index + 1}`;
    reply.rows = 3;
    reply.value = sample.raw;
    const save = make('button', '保存回复', 'secondary');
    save.type = 'button';
    save.disabled = !reply.value.trim();
    const message = make('span', undefined, 'fine-print');
    message.setAttribute('role', 'status');
    const actions = make('div', undefined, 'manual-actions');
    actions.append(save, message);
    contents.append(prompt, copy, label, reply, actions);
    detail.append(contents);
    manualReplies.append(detail);

    copy.addEventListener('click', async () => {
      const copied = await api.copyChallenge(index);
      if (copied) copy.textContent = '已复制';
    });
    reply.addEventListener('input', () => {
      save.disabled = !reply.value.trim();
      message.textContent = '回复待保存';
    });
    save.addEventListener('click', async () => {
      const raw = reply.value;
      if (await api.saveReply(index, raw)) {
        message.textContent = reply.value === raw ? '回复已保存' : '修改待保存';
      } else message.textContent = '请输入有效回复，最多 262144 个字符。';
    });
  }
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

  const heading = run.status === 'running' && run.mode === 'manual' ? '等待手动回复'
    : run.analysis?.results.length && run.conditions !== 'isolated-config' ? `${results[run.status]} · 限制条件` : results[run.status];
  resultBody.replaceChildren(make('h3', heading, 'result-heading'));
  if (run.status === 'running') return;
  if (run.message) resultBody.append(make('p', run.message, 'callout'));
  if (run.limitation) resultBody.append(make('p', run.limitation, 'callout'));
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
  metadata.append(make('span', `${sources[run.source].title}${run.clientVersion ? ` ${run.clientVersion}` : ''} · ${run.mode === 'manual' ? '手动' : '自动'}`));
  metadata.append(make('span', `${run.mode === 'manual' ? '用户填写模型' : '请求模型'} · ${run.model === 'cli-default' ? 'CLI 当前默认模型' : run.model}${run.effort ? ` · ${run.effort}` : ''}`));
  if (run.account) metadata.append(make('span', accountText[run.account]));
  metadata.append(make('span', run.route ? `${run.route.provider} · ${run.route.origin ?? '请求地址未核验'}` : '路由未核验'));
  if (run.executablePath) metadata.append(make('span', run.executablePath));
  metadata.append(make('span', `SDK ${run.sdk}`));
  if (run.bank) metadata.append(make('span', `快照 ${date(run.bank.builtAt)} · ${run.bank.sha256.slice(0, 12)}`));
  evidence.append(metadata, make('p', run.routeBasis, 'fine-print'));
  if (run.route?.kind === 'chatgpt') {
    const received = run.samples.some((sample) => sample.status === 'received');
    evidence.append(make('p', received ? '官方账号地址已收到 Codex 的完整回复。' : '官方账号地址未收到完整回复，账号通道实测未通过。', 'fine-print'));
  }

  for (const [index, sample] of run.samples.entries()) {
    const detail = make('details');
    detail.append(make('summary', `样本 ${index + 1} · ${statusText[sample.status]} · ${sample.count} / ${sample.expected}`));
    const contents = make('div', undefined, 'sample-evidence');
    if (sample.error) contents.append(make('p', sample.error, 'callout'));
    if (sample.threadId) contents.append(make('p', `会话 ${sample.threadId}`, 'fine-print'));
    if (sample.clientModel) contents.append(make('p', `CLI 报告模型 ${sample.clientModel}`, 'fine-print'));
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

function renderRoute(state: DesktopState) {
  const { connection } = state;
  const choice = connection.models.find(({ id }) => id === model.value);
  const account = choice?.account ?? connection.account;
  get('account').textContent = account ? accountText[account] : connection.state === 'checking' ? '读取中…' : '未核验';
  const route = choice?.route ?? connection.route;
  const manual = isManualSource(state.source);
  get('route').textContent = route
    ? route.kind === 'chatgpt' ? '官方 ChatGPT 账号地址' : route.kind === 'openai-api' ? 'OpenAI API'
      : route.kind === 'custom' ? `自定义路由 · ${route.provider}` : `客户端提供方 · ${route.provider}`
    : manual ? '手动复制与粘贴 · 路由未核验' : '未核验';
  const routeMessage = route?.kind === 'chatgpt'
    ? `采样指定 ${route.origin}。账号通道需通过真实采样验证。${connection.configuredProvider && connection.configuredProvider !== 'openai' ? ` Codex 默认提供方为 ${connection.configuredProvider}。` : ''}`
    : route?.kind === 'custom' ? `网关 ${route.origin} · 复用 Codex 托管的 API Key 和网关地址。`
    : route?.kind === 'client-config' ? route.origin ? `配置地址 ${route.origin}` : '请求地址未核验。' : null;
  explain('route-detail', routeMessage);
}

function render(state: DesktopState) {
  if (last?.source !== state.source) manualModel.value = '';
  last = state;
  const { connection, detection } = state;
  const title = sources[state.source].title;
  const manual = isManualSource(state.source);
  const running = detection?.status === 'running';
  if (!running) cancelling = false;
  sourceSelect.value = state.source;
  sourceSelect.disabled = running || starting || state.changingCodex;
  const badge = get('connection-badge');
  badge.dataset.tone = connection.state === 'ready' ? 'good' : connection.state === 'checking' ? 'pending' : 'bad';
  badge.textContent = connection.state === 'ready' ? `${manual ? '手动采样' : title}${connection.version ? ` · ${connection.version}` : ''}`
    : connection.state === 'checking' ? `正在检查 ${title}` : `${title} 不可用`;
  explain('connection-message', connection.message);
  const failures = connection.diagnostics?.filter((entry) => entry.status === 'error') ?? [];
  const probes = get<HTMLDetailsElement>('probe-diagnostics');
  probes.hidden = !failures.length;
  get('probe-failures').replaceChildren(...failures.map((entry) => make('li',
    `${probeContext[entry.context]} · ${entry.method} · ${entry.rpcCode === null ? entry.message : `RPC ${entry.rpcCode}`}`)));
  get('codex-settings').hidden = state.source !== 'codex';
  get('codex-mode').textContent = connection.configuredExecutablePath ? '手动指定' : '自动查找（PATH）';
  get('codex-path').textContent = connection.executablePath ?? connection.configuredExecutablePath
    ?? (connection.state === 'checking' ? '正在查找…' : '未找到 Codex 程序');
  get('codex-path').title = connection.executablePath ?? connection.configuredExecutablePath ?? '';

  const key = `${state.source}:${JSON.stringify(connection.models)}`;
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
  renderRoute(state);

  const ready = connection.state === 'ready' && !running && !starting && !state.changingCodex;
  model.hidden = manual;
  model.disabled = !ready || manual;
  manualModel.hidden = !manual;
  manualModel.disabled = !ready || !manual;
  get<HTMLLabelElement>('model-label').htmlFor = manual ? 'manual-model' : 'model';
  start.disabled = !ready || (!manual && !connection.models.length);
  start.textContent = manual ? '生成挑战' : '开始检测';
  start.hidden = Boolean(running);
  cancel.hidden = !running;
  cancel.disabled = cancelling;
  cancel.textContent = cancelling ? '正在取消…' : '取消';
  const busy = Boolean(running || starting || state.changingCodex || connection.state === 'checking');
  refresh.disabled = busy;
  chooseCodex.disabled = busy;
  usePathCodex.disabled = busy || (connection.state !== 'error' && !connection.configuredExecutablePath);
  get('sample-note').textContent = connection.note ?? (manual ? '手动采样 · 账号与路由未核验。' : '每次检测提交三条独立的数字挑战，使用所选通道的额度。');
  exportButton.disabled = !detection || running || exporting || exportedRun === detection.id;
  renderManual(detection);
  renderProgress(detection);
  renderResult(detection);
  renderBank(state.bank);
}

get<HTMLFormElement>('detect-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (start.disabled || !last) return;
  const source = last.source;
  const selected = isManualSource(source) ? manualModel.value : model.value;
  explain('export-message', null);
  starting = true;
  render(last);
  try { await api.start(source, selected); }
  finally { starting = false; if (last) render(last); }
});
sourceSelect.addEventListener('change', () => { void api.selectSource(sourceSelect.value as Source); });
model.addEventListener('change', () => { if (last) renderRoute(last); });
scoreReplies.addEventListener('click', () => { void api.scoreReplies(); });
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
