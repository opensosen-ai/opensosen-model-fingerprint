import { AppServer, CodexError, array, bundledModels, findCodex, object, string, withEmptyDirectory, type Fields } from './codex-process.js';
import type { AccountMode, Connection, ModelChoice, Route } from './types.js';

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

export function accountMode(response: Fields): AccountMode {
  if (response.account === null) return 'signedOut';
  const type = object(response.account).type;
  if (type === 'apiKey' || type === 'chatgpt') return type;
  return 'other';
}

export function sameAccount(first: Fields, second: Fields) {
  const mode = accountMode(first);
  if (mode !== accountMode(second)) return false;
  if (mode !== 'chatgpt') return mode === 'apiKey';
  const fields = (data: Fields) => [data.userId, object(data.account).email, object(data.account).workspaceName];
  const selected = fields(first);
  const candidate = fields(second);
  return selected.every((value, index) => value === candidate[index]);
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
  const provider = string(configured.defaultProviderId);
  if (!provider) throw new CodexError('Codex 未报告当前提供方。');
  if (account === 'chatgpt') {
    const selected = array(official.data).map(object).find((p) => p.id === 'openai');
    if (official.defaultProviderId !== 'openai' || !selected || selected.baseUrl !== null) {
      throw new CodexError('当前 Codex 配置未能确认内置 OpenAI 提供方。官方 ChatGPT 通道未验证。');
    }
    return {
      route: { provider: 'openai', origin: new URL(CHATGPT_API).origin, kind: 'chatgpt' } satisfies Route,
      config: { model_provider: 'openai', openai_base_url: CHATGPT_API, chatgpt_base_url: CHATGPT_BACKEND },
    };
  }
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

async function findAccountStore(executable: string, cwd: string, expected: Fields, signal: AbortSignal) {
  for (const store of ['file', 'keyring']) {
    const server = new AppServer(executable, cwd, { ...OFFICIAL_ACCOUNT_PROBE, cli_auth_credentials_store: store });
    try {
      await server.initialize(signal);
      const account = await server.request('account/read', { refreshToken: false }, signal);
      if (sameAccount(expected, account)) return store;
    } catch {
      signal.throwIfAborted();
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
    const current = new AppServer(executable, cwd, PROBE_CONFIG);
    let official: AppServer | null = null;
    const connection = { ...emptyConnection('checking'), configuredExecutablePath, executablePath: executable };
    try {
      // Initialize the first app-server fully before starting another against the same SQLite home.
      const version = await current.initialize(signal);
      connection.version = version;
      official = new AppServer(executable, cwd, OFFICIAL_ACCOUNT_PROBE);
      await official.initialize(signal);
      const [configured, activeAccount, officialAccount] = await Promise.all([
        current.request('modelProvider/list', {}, signal),
        current.request('account/read', { refreshToken: false }, signal),
        official.request('account/read', { refreshToken: false }, signal),
      ]);
      connection.configuredProvider = string(configured.defaultProviderId);
      const activeMode = accountMode(activeAccount);
      const officialMode = accountMode(officialAccount);
      const account = connection.account = officialMode === 'chatgpt' ? 'chatgpt' : activeMode === 'signedOut' ? officialMode : activeMode;
      if (account === 'signedOut') return { connection: {
        ...connection, state: 'signedOut', message: 'Codex 未登录。请在官方 Codex 客户端登录，然后在此刷新。',
      }, ready: null };
      if (account === 'other') return { connection: {
        ...connection, state: 'unsupported', message: 'Codex 报告了其他登录类型。此版本支持 Codex 托管的 ChatGPT 和 API Key 登录。',
      }, ready: null };

      if (!version) throw new CodexError('Codex 没有报告可识别的版本。');
      const providerMetadata = account === 'chatgpt' ? await official.request('modelProvider/list', {}, signal) : configured;
      const { route, config } = chooseRoute(account, configured, providerMetadata, activeAccount.requiresOpenaiAuth === true);
      connection.route = route;
      const [listed, store, bundled] = await Promise.all([
        modelChoices(account === 'chatgpt' ? official : current, route.provider, signal),
        findAccountStore(executable, cwd, account === 'chatgpt' ? officialAccount : activeAccount, signal),
        bundledModels(executable, cwd, signal),
      ]);
      const models = listed.filter(({ id }) => bundled.has(id));
      if (!models.length) throw new CodexError('Codex 未返回可隔离工具的文本模型。');
      if (models.length < listed.length) connection.message = `${listed.length - models.length} 个文本模型缺少内置定义，当前列表显示可进行纯文本采样的模型。`;
      const readyConnection = { ...connection, state: 'ready' as const, account, route, version, models };
      const routeConfig = { ...config, cli_auth_credentials_store: store };
      return { connection: readyConnection, ready: { connection: readyConnection, executable, routeConfig, bundled } };
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
