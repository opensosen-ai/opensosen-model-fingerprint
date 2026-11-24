import { createHash } from 'node:crypto';
import { AppServer, CodexError, CodexRpcError, array, bundledModels, codexExecutableIdentity, findCodex, object, string, withEmptyDirectory, type Fields } from './codex-process.js';
import type { AccountMode, CodexProbeDiagnostic, Connection, ModelChoice, Route } from './types.js';

const OPENAI_API = 'https://api.openai.com/v1';
const CHATGPT_API = 'https://chatgpt.com/backend-api/codex';
const CHATGPT_BACKEND = 'https://chatgpt.com/backend-api/';
const PROBE_CONFIG = {
  'analytics.enabled': false,
  'features.hooks': false,
  'features.plugins': false,
  'features.apps': false,
  chatgpt_base_url: CHATGPT_BACKEND,
};
const OFFICIAL_ACCOUNT_PROBE = { ...PROBE_CONFIG, model_provider: 'openai', openai_base_url: '' };

export interface ReadyCodex {
  executable: string;
  binaryIdentity: string;
  accountBinding: string;
  routeConfig: Fields;
  bundled: ReadonlyMap<string, Fields>;
  connection: Connection & { state: 'ready'; account: 'chatgpt' | 'apiKey'; route: Route; version: string };
}

export interface Inspection {
  connection: Connection;
  ready: ReadyCodex | null;
}

export function emptyConnection(state: Connection['state'], message: string | null = null): Connection {
  return {
    state, account: null, version: null, configuredProvider: null, route: null, models: [], message,
    configuredExecutablePath: null, executablePath: null,
  };
}

export function accountMode(response: Fields): 'chatgpt' | 'apiKey' | 'signedOut' | 'other' {
  if (response.account === null) return 'signedOut';
  const type = object(response.account).type;
  if (type === 'apiKey' || type === 'chatgpt') return type;
  return 'other';
}

export function sameAccount(first: Fields, second: Fields) {
  const binding = accountBinding(first);
  return binding !== null && binding === accountBinding(second);
}

function accountBinding(data: Fields) {
  const mode = accountMode(data);
  if (mode === 'apiKey') return mode;
  if (mode !== 'chatgpt') return null;
  const account = object(data.account);
  const userId = string(data.userId)?.trim() || null;
  const email = string(account.email)?.trim() || null;
  if (!userId && !email) return null;
  // Keep the identity available for revalidation without exposing the email
  // or account identifier to the renderer or the exported run.
  return createHash('sha256').update(JSON.stringify([userId, email, string(account.workspaceName)])).digest('hex');
}

function endpoint(raw: unknown) {
  if (typeof raw !== 'string') return null;
  try {
    const url = new URL(raw);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    return url;
  } catch {
    return null;
  }
}

export function chooseRoute(account: AccountMode, configured: Fields, official: Fields, requiresOpenaiAuth: boolean) {
  if (account === 'chatgpt') {
    const selected = array(official.data).map(object).find((p) => p.id === 'openai');
    if (official.defaultProviderId !== 'openai' || !selected || selected.baseUrl !== null || object(selected.settings).type !== 'openai') {
      throw new CodexError('当前 Codex 配置未能确认内置 OpenAI 提供方。官方 ChatGPT 通道未验证。');
    }
    return {
      route: { provider: 'openai', origin: new URL(CHATGPT_API).origin, kind: 'chatgpt' } satisfies Route,
      config: { model_provider: 'openai', openai_base_url: CHATGPT_API, chatgpt_base_url: CHATGPT_BACKEND },
    };
  }
  const provider = string(configured.defaultProviderId);
  if (!provider) throw new CodexError('Codex 未报告当前提供方。');
  if (account !== 'apiKey' || !requiresOpenaiAuth) {
    throw new CodexError('当前提供方没有报告可复用的 Codex 托管 API Key 登录。');
  }
  const selected = array(configured.data).map(object).find((p) => p.id === provider);
  const settings = object(selected?.settings);
  const base = endpoint(selected?.baseUrl);
  if (provider === 'openai' && settings.type === 'openai') {
    if (!base && selected?.baseUrl !== null) throw new CodexError('Codex 返回的内置提供方地址不可用。');
    const url = base ?? new URL(OPENAI_API);
    return {
      route: { provider, origin: url.origin, kind: url.href.replace(/\/$/, '') === OPENAI_API ? 'openai-api' : 'custom' } satisfies Route,
      config: { model_provider: provider, openai_base_url: url.href },
    };
  }
  const auth = object(settings.auth);
  if (!base || !/^[a-zA-Z0-9_-]+$/.test(provider) || settings.type !== 'customGateway' ||
      auth.mode !== 'externallyConfigured' || auth.envKey !== null) {
    throw new CodexError('当前自定义路由的访问方式无法用 Codex 托管登录安全复现。请在 Codex 中选择兼容的提供方后刷新。');
  }
  // Keep the configured endpoint and explicitly use Codex's existing managed API key.
  // The public metadata cannot reproduce private headers or external auth helpers.
  const key = `model_providers.${provider}`;
  return {
    route: { provider, origin: base.origin, kind: 'custom' } satisfies Route,
    config: {
      model_provider: provider,
      [`${key}.name`]: provider,
      [`${key}.base_url`]: base.href,
      [`${key}.wire_api`]: 'responses',
      [`${key}.requires_openai_auth`]: true,
      [`${key}.request_max_retries`]: 0,
      [`${key}.stream_max_retries`]: 0,
    },
  };
}

type ProbeContext = CodexProbeDiagnostic['context'];

async function probe<T>(diagnostics: CodexProbeDiagnostic[], context: ProbeContext, method: string, signal: AbortSignal, call: () => Promise<T>) {
  try {
    const value = await call();
    diagnostics.push({ context, method, status: 'ok', rpcCode: null, message: null });
    return value;
  } catch (error) {
    signal.throwIfAborted();
    diagnostics.push({ context, method, status: 'error', rpcCode: error instanceof CodexRpcError ? error.rpcCode : null, message: publicError(error) });
    return null;
  }
}

async function requestVersion(server: AppServer, signal: AbortSignal) {
  const version = await server.initialize(signal);
  if (!version) throw new CodexError('Codex 没有报告可识别的版本。');
  return version;
}

function readAccount(server: AppServer, signal: AbortSignal) {
  return server.request('account/read', { refreshToken: false }, signal);
}

async function findAccountStore(
  executable: string, cwd: string, expected: Fields, version: string, config: Fields,
  signal: AbortSignal, diagnostics: CodexProbeDiagnostic[],
) {
  for (const store of ['file', 'keyring'] as const) {
    const context = `storage-${store}` as const;
    const server = new AppServer(executable, cwd, { ...PROBE_CONFIG, ...config, cli_auth_credentials_store: store });
    try {
      const selected = await probe(diagnostics, context, 'initialize', signal, () => requestVersion(server, signal));
      if (selected !== version) continue;
      const account = await probe(diagnostics, context, 'account/read', signal, async () => {
        const received = await readAccount(server, signal);
        if (received.requiresOpenaiAuth !== true || !sameAccount(expected, received)) {
          throw new CodexError('此凭据存储未报告同一托管账号。');
        }
        return received;
      });
      if (account) return store;
    } finally {
      await server.close();
    }
  }
  throw new CodexError('Codex 的隔离进程无法确认当前托管登录。请在官方客户端完成登录并刷新。');
}

async function modelChoices(server: AppServer, provider: string, signal: AbortSignal) {
  const models = new Map<string, ModelChoice>();
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const list = await server.request('model/list', { modelProvider: provider, limit: 100, includeHidden: false, cursor }, signal, 30_000);
    for (const row of array(list.data).map(object)) {
      const id = string(row.model);
      if (!id || row.hidden === true || !array(row.inputModalities).includes('text')) continue;
      models.set(id, { id, title: string(row.displayName) || id, effort: string(row.defaultReasoningEffort), isDefault: row.isDefault === true });
    }
    cursor = string(list.nextCursor);
    if (cursor && (seen.size >= 49 || seen.has(cursor))) throw new CodexError('Codex 返回了无效的模型列表分页。');
    if (cursor) seen.add(cursor);
  } while (cursor);
  return [...models.values()];
}

export async function inspectCodex(signal: AbortSignal, configuredExecutablePath: string | null = null): Promise<Inspection> {
  const executable = await findCodex(configuredExecutablePath);
  if (!executable) return {
    connection: emptyConnection('missing', configuredExecutablePath
      ? `找不到已选择的 Codex：${configuredExecutablePath}`
      : '找不到官方 Codex CLI。请让 codex.exe 或官方 npm 的 codex.cmd 可通过 PATH 找到，然后刷新。'),
    ready: null,
  };

  return withEmptyDirectory(async (cwd) => {
    const binaryIdentity = codexExecutableIdentity(executable);
    const current = new AppServer(executable, cwd, PROBE_CONFIG);
    let official: AppServer | null = null;
    const diagnostics: CodexProbeDiagnostic[] = [];
    const connection = { ...emptyConnection('checking'), configuredExecutablePath, executablePath: executable, diagnostics };
    const detail = (context: ProbeContext, method: string) =>
      diagnostics.find((entry) => entry.context === context && entry.method === method && entry.status === 'error')?.message;
    try {
      // Initialize the first app-server fully before starting another against the same SQLite home.
      const currentVersion = await probe(diagnostics, 'configured', 'initialize', signal, () => requestVersion(current, signal));
      official = new AppServer(executable, cwd, OFFICIAL_ACCOUNT_PROBE);
      const officialServer = official;
      const officialVersion = await probe(diagnostics, 'official', 'initialize', signal, () => requestVersion(officialServer, signal));
      connection.version = currentVersion ?? officialVersion;
      if (currentVersion && officialVersion && currentVersion !== officialVersion) throw new CodexError('两次 Codex 检查返回了不同的程序版本。');
      const [configured, activeAccount, officialAccount] = await Promise.all([
        currentVersion ? probe(diagnostics, 'configured', 'modelProvider/list', signal, () => current.request('modelProvider/list', {}, signal)) : null,
        currentVersion ? probe(diagnostics, 'configured', 'account/read', signal, () => readAccount(current, signal)) : null,
        officialVersion ? probe(diagnostics, 'official', 'account/read', signal, () => readAccount(officialServer, signal)) : null,
      ]);
      connection.configuredProvider = string(configured?.defaultProviderId);
      const activeMode = activeAccount ? accountMode(activeAccount) : null;
      const officialMode = officialAccount ? accountMode(officialAccount) : null;
      const useOfficial = officialMode === 'chatgpt';
      if (useOfficial && officialAccount && activeAccount && activeMode !== 'signedOut' && !sameAccount(activeAccount, officialAccount)) {
        throw new CodexError('当前配置和官方上下文报告了不同账号。请在 Codex 检查登录后刷新。');
      }
      if (!useOfficial && activeMode === 'chatgpt') {
        connection.account = activeMode;
        throw new CodexError('当前配置报告 ChatGPT 登录，官方账号探针未确认该账号。');
      }
      const account = connection.account = useOfficial ? 'chatgpt' : activeMode;
      if (!account) throw new CodexError(detail('configured', 'account/read') ?? detail('configured', 'initialize') ?? 'Codex 未确认当前托管账号。');
      if (account === 'signedOut' || account === 'other') {
        return { connection: { ...connection, state: account === 'signedOut' ? 'signedOut' : 'unsupported',
          message: account === 'signedOut' ? 'Codex 未登录。请在官方 Codex 客户端登录，然后在此刷新。'
            : '此版本支持 Codex 托管的 ChatGPT 和 API Key 登录。' }, ready: null };
      }
      const accountProof = useOfficial ? officialAccount : activeAccount;
      const binding = accountProof && accountBinding(accountProof);
      const version = useOfficial ? officialVersion : currentVersion;
      if (!accountProof || !binding || !version || accountProof.requiresOpenaiAuth !== true) {
        throw new CodexError('Codex 未能确认可绑定到独立采样进程的托管账号。');
      }
      const providerMetadata = useOfficial
        ? await probe(diagnostics, 'official', 'modelProvider/list', signal, () => officialServer.request('modelProvider/list', {}, signal))
        : configured;
      const context = useOfficial ? 'official' : 'configured';
      if (!providerMetadata) throw new CodexError(detail(context, 'modelProvider/list') ?? 'Codex 未确认检测提供方。');
      const { route, config } = chooseRoute(account, configured ?? {}, providerMetadata, true);
      connection.route = route;
      const [listed, bundled] = await Promise.all([
        probe(diagnostics, context, 'model/list', signal, () => modelChoices(useOfficial ? officialServer : current, route.provider, signal)),
        probe(diagnostics, context, 'debug models --bundled', signal, () => bundledModels(executable, cwd, signal)),
      ]);
      if (!listed || !bundled) throw new CodexError(detail(context, 'model/list') ?? detail(context, 'debug models --bundled') ?? 'Codex 未确认可用模型。');
      const models = listed.filter(({ id }) => bundled.has(id));
      if (!models.length) throw new CodexError('Codex 未返回可隔离工具的文本模型。');
      const store = await findAccountStore(executable, cwd, accountProof, version, config, signal, diagnostics);
      if (codexExecutableIdentity(executable) !== binaryIdentity) throw new CodexError('检查期间 Codex 程序已变化，请刷新连接。');
      if (models.length < listed.length) connection.message = `${listed.length - models.length} 个文本模型缺少内置定义，当前列表显示可进行纯文本采样的模型。`;
      const readyConnection = { ...connection, state: 'ready' as const, account, route, version, models };
      const routeConfig = { ...config, cli_auth_credentials_store: store };
      return { connection: readyConnection, ready: { connection: readyConnection, executable, binaryIdentity, accountBinding: binding, routeConfig, bundled } };
    } catch (error) {
      return { connection: { ...connection, state: 'error', message: publicError(error) }, ready: null };
    } finally {
      await Promise.all([current.close(), official?.close()]);
    }
  });
}

export function publicError(error: unknown): string {
  return error instanceof CodexError ? error.message : 'Codex 连接失败。请检查本机 CLI、登录状态和提供方设置后刷新。';
}
