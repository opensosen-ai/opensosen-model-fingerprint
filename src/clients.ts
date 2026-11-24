import { unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseNumbers } from 'lmfpd-sdk';
import { commandOutput, findCommand, runCommand, type Command } from './cli-process.js';
import { emptyConnection } from './codex.js';
import { array, object, string, withEmptyDirectory, type Fields } from './codex-process.js';
import { createDetection, finishDetection, MAX_REPLY_LENGTH, SAMPLE_TIMEOUT_MS, type CollectOptions } from './collect.js';
import { sources, type AccountMode, type CliSource, type Connection, type Detection, type ModelChoice, type Route, type SampleEvidence } from './types.js';

const OPEN_CODE_AGENT = 'opensosen-fingerprint';
const OPEN_CODE_CONFIG = {
  policies: ['mcp.use', 'skill.use', 'plugin.use', 'websearch.use', 'tool.use']
    .map((action) => ({ action, resource: '*', effect: 'deny' })),
  agents: {
    [OPEN_CODE_AGENT]: {
      mode: 'primary', system: 'Follow the user prompt exactly.',
      permissions: [{ action: '*', resource: '*', effect: 'deny' }],
    },
  },
};
const DEFAULT_MODEL: ModelChoice = { id: 'cli-default', title: 'CLI 当前默认模型', isDefault: true, effort: null };
const CLAUDE_FLAGS = [
  '--print', '--safe-mode', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
  '--tools', '', '--disable-slash-commands', '--no-chrome', '--no-session-persistence',
  '--max-turns', '1', '--permission-mode', 'dontAsk', '--system-prompt', 'Follow the user prompt exactly.',
  '--output-format', 'stream-json', '--verbose',
];
const DSH_PROFILE = ['--profile', 'headless'];
const DSH_CONTEXT_ROWS = new Set(['agent-instructions', 'skill', 'skill-filesystem', 'mcp-client', 'mcp-manager', 'mcp-resources', 'session-persistence-jsonl']);

const cliInfo = {
  'claude-code': {
    transport: 'claude --print --output-format stream-json',
    routeBasis: 'Claude Code auth status 与可见的进程端点配置',
    limitation: '每题使用空目录和新会话，关闭常规工具、MCP、项目文档与用户自定义内容。Claude Code 的组织托管策略和钩子可能继续生效。',
  },
  opencode: {
    transport: 'opencode --standalone run --format json',
    routeBasis: 'OpenCode --standalone models 与脱敏的 debug config',
    limitation: '每题使用独立目录、私有服务器和归档会话，应用拒绝工具、MCP、技能与插件策略。全局或托管配置及内建系统上下文仍可能影响请求。',
  },
  'dsh-cli': {
    transport: 'dsh --profile headless --json',
    routeBasis: 'DSH headless 配置由 CLI 解析，实际账号与路由未核验',
    limitation: '每题在空目录启动独立 headless 会话，使用只读预设和临时配置禁用已识别的工具与项目指令。自定义插件和内建提示仍可能影响请求。',
  },
} satisfies Record<CliSource, { transport: string; routeBasis: string; limitation: string }>;

export interface ReadyClient {
  source: CliSource;
  command: Command;
  connection: Connection;
  dshRows?: string[];
}

function safeId(value: unknown) {
  const text = string(value);
  return text && /^[a-zA-Z0-9][a-zA-Z0-9._:/#-]{0,159}$/.test(text) ? text : null;
}

function publicOrigin(value: unknown) {
  try {
    const url = new URL(string(value) ?? '');
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.origin : null;
  } catch { return null; }
}

function json(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}

export function claudeAccount(status: Fields): AccountMode | null {
  if (status.loggedIn === false) return 'signedOut';
  if (status.loggedIn !== true) return null;
  if (status.authMethod === 'claude.ai') return 'claude';
  if (status.authMethod === 'oauth_token') return 'oauth';
  if (status.authMethod === 'api_key' || status.authMethod === 'api_key_helper') return 'apiKey';
  return 'other';
}

export function cliVersion(output: string) {
  return output.match(/(?:^|\s)v?(\d+\.\d+\.\d+(?:-[\w.-]+)?)(?=\s|$)/i)?.[1] ?? null;
}

export function openCodeModels(output: string, config: unknown): ModelChoice[] {
  const providers = new Map<string, Fields>();
  let defaultId: string | null = null;
  for (const row of array(config).map(object)) {
    const info = object(row.info);
    for (const [id, provider] of Object.entries(object(info.providers))) {
      const settings = { ...providers.get(id), ...object(object(provider).settings) };
      providers.set(id, settings);
    }
    const model = object(info.model);
    const providerId = safeId(model.providerID);
    const modelId = safeId(model.model);
    defaultId = safeId(info.model) ?? (providerId && modelId ? `${providerId}/${modelId}` : defaultId);
  }
  return [...new Set(output.split(/\r?\n/).map((line) => line.trim()))]
    .filter((id) => safeId(id) && id.split('/').length >= 2)
    .map((id) => {
      const provider = id.split('/')[0];
      const settings = providers.get(provider);
      return {
        id, title: id, isDefault: id === defaultId, effort: null,
        route: { provider, origin: publicOrigin(settings?.baseURL), kind: 'client-config' },
        // The diagnostic redacts this field. Absence does not imply logged out.
        account: settings?.apiKey === '***' ? 'apiKey' : 'clientConfigured',
      };
    });
}

async function withConfig<T>(cwd: string, name: string, content: unknown, work: (path: string) => Promise<T>) {
  const file = join(cwd, name);
  await writeFile(file, JSON.stringify(content), { flag: 'wx' });
  try { return await work(file); }
  finally { await unlink(file).catch(() => {}); }
}

export async function inspectClient(source: CliSource, signal: AbortSignal): Promise<{ connection: Connection; ready: ReadyClient | null }> {
  const title = sources[source].title;
  const command = await findCommand(source);
  if (!command) return { connection: emptyConnection('missing', `未找到可运行的 ${title} CLI。安装后刷新连接。`), ready: null };
  const connection = emptyConnection('checking');
  connection.executablePath = command.prefix[0] ?? command.file;
  connection.note = cliInfo[source].limitation;
  let dshRows: string[] | undefined;
  const fail = (state: Connection['state'], message: string) => ({ connection: { ...connection, state, message }, ready: null });

  return withEmptyDirectory(async (cwd) => {
    const env = isolatedEnvironment(cwd);
    const versionOutput = await commandOutput(command, ['--version'], cwd, signal);
    signal.throwIfAborted();
    const version = cliVersion(versionOutput.stdout);
    if (versionOutput.code !== 0 || !version) return fail('error', `无法读取 ${title} 版本。请检查 CLI 能否从终端运行。`);
    connection.version = version;

    if (source === 'claude-code') {
      const [auth, help] = await Promise.all([
        commandOutput(command, ['auth', 'status', '--json'], cwd, signal),
        commandOutput(command, ['--help'], cwd, signal),
      ]);
      signal.throwIfAborted();
      const status = object(json(auth.stdout));
      connection.account = claudeAccount(status);
      if (connection.account === 'signedOut') return fail('signedOut', 'Claude Code 报告未登录。可在 Claude Code 自行检查登录后刷新。');
      if (auth.code !== 0 || !connection.account) return fail('error', '无法读取 Claude Code 登录状态，请检查 claude auth status。');
      if (!['--safe-mode', '--strict-mcp-config', '--no-session-persistence', '--tools'].every((flag) => help.stdout.includes(flag))) {
        return fail('unsupported', '此版 Claude Code 缺少隔离采样选项，请更新后刷新。');
      }
      const provider = safeId(status.apiProvider);
      connection.route = provider ? { provider, origin: publicOrigin(process.env.ANTHROPIC_BASE_URL), kind: 'client-config' } : null;
      connection.models = [DEFAULT_MODEL];
    } else if (source === 'opencode') {
      const parts = version.split('.').map(Number);
      if (parts[0] !== 2 || (parts[1] < 2 || (parts[1] === 2 && parts[2] < 3))) {
        return fail('unsupported', '此适配使用 OpenCode 2.2.3 或更新的 2.x 版配置与事件格式。');
      }
      const configured = await withConfig(cwd, 'opencode.json', OPEN_CODE_CONFIG, async () => {
        const models = await commandOutput(command, ['--standalone', 'models'], cwd, signal, 20_000, env);
        if (models.code !== 0) return null;
        const config = await commandOutput(command, ['--standalone', 'debug', 'config'], cwd, signal, 20_000, env);
        const entries = array(json(config.stdout)).map(object);
        if (config.code !== 0 || !entries.some((entry) => Object.hasOwn(object(object(entry.info).agents), OPEN_CODE_AGENT))) return null;
        return openCodeModels(models.stdout, entries);
      });
      signal.throwIfAborted();
      if (!configured?.length) return fail('error', 'OpenCode 未列出可用模型。请检查现有提供方配置与 opencode models。');
      connection.models = configured;
    } else {
      const [help, config] = await Promise.all([
        commandOutput(command, [...DSH_PROFILE, '--help'], cwd, signal),
        commandOutput(command, [...DSH_PROFILE, '--dump-default-config'], cwd, signal),
      ]);
      signal.throwIfAborted();
      if (help.code !== 0 || config.code !== 0 || !help.stdout.includes('--json') ||
        !help.stdout.includes('--permission-mode') || !help.stdout.includes('--approval-policy')) {
        return fail('unsupported', '此版 DSH 缺少可用的 headless JSON 或权限预设，请检查 dsh --profile headless --help。');
      }
      dshRows = [...new Set([...config.stdout.matchAll(/^- id: ([a-z0-9-]+)\s*$/gm)].map((match) => match[1]))]
        .filter((id) => DSH_CONTEXT_ROWS.has(id) || (id.startsWith('tool-') && !id.startsWith('tool-executor-')));
      if (!dshRows.length) return fail('unsupported', '无法识别 DSH 的默认 headless 配置，请更新客户端后刷新。');
      connection.models = [DEFAULT_MODEL];
    }
    connection.state = 'ready';
    return { connection, ready: { source, command, connection, dshRows } };
  });
}

function isolatedEnvironment(cwd: string) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'PWD') delete env[key];
  env.PWD = cwd;
  return env;
}

export function makeClientDetection(client: ReadyClient, model: ModelChoice) {
  return createDetection({
    source: client.source, mode: 'automatic', clientVersion: client.connection.version,
    executablePath: client.connection.executablePath, account: model.account ?? client.connection.account,
    model: model.id, effort: model.effort, route: model.route ?? client.connection.route,
    conditions: 'agent-context-unverified', ...cliInfo[client.source],
  });
}

function requestError(source: CliSource, message: unknown) {
  const text = string(message) ?? '';
  if (source === 'dsh-cli' && /MISSING_CREDENTIAL/i.test(text)) {
    const provider = text.replace(/\\(?=")/g, '').match(/provider route ["']([a-zA-Z0-9._-]{1,70})["']/i)?.[1];
    return `DSH headless 缺少凭据（MISSING_CREDENTIAL${provider ? ` · ${provider}` : ''}）。请核对 CLI 的 headless 认证配置。`;
  }
  const status = text.match(/\b(400|401|403|404|408|409|422|429|500|502|503|504)\b/)?.[0];
  if (status) return `${sources[source].title} 请求失败（HTTP ${status}）。`;
  if (/auth|login|log in|credential|api.?key|unauthorized|oauth/i.test(text)) {
    return `${sources[source].title} 认证失败。请检查当前 CLI 登录、凭据和路由。`;
  }
  if (/model.*(?:not supported|unavailable|not found)|unknown model/i.test(text)) return '提供方拒绝了所选模型。';
  if (/timed? out|timeout/i.test(text)) return '模型服务连接超时。';
  return null;
}

export function clientEvents(source: CliSource, sample: SampleEvidence, update: () => void) {
  let completed = false;
  let failure: string | null = null;
  let reportedError = false;
  const parts = new Map<string, string>();
  const save = (raw: string) => {
    if (raw.length > MAX_REPLY_LENGTH) {
      failure = '回复超过应用的证据大小限制。';
      return false;
    }
    sample.raw = raw;
    sample.count = parseNumbers(raw).length;
    update();
    return true;
  };
  return {
    onLine(line: string) {
      const event = object(json(line));
      const type = string(event.type);
      const thread = safeId(event.session_id ?? event.sessionID ?? event.sessionId);
      if (thread && !sample.threadId) sample.threadId = thread;
      const message = object(event.message);
      const part = object(event.part);
      const content = array(message.content).map(object);
      const tools = array(event.tools).length || array(event.mcp_servers).length ||
        content.some((item) => item.type === 'tool_use' || item.type === 'server_tool_use');
      if (tools || ['tool_use', 'tool_call', 'tool_result'].includes(type ?? '')) {
        failure = `${sources[source].title} 报告工具或 MCP 活动，该样本排除评分。`;
        return false;
      }
      if (source === 'claude-code') {
        if (type === 'system' && event.subtype === 'init') sample.clientModel = safeId(event.model) ?? undefined;
        if (type === 'assistant' && !event.error) {
          const text = content.filter((item) => item.type === 'text').map((item) => string(item.text) ?? '').join('');
          if (!text) return;
          parts.set(safeId(message.id) ?? String(parts.size), text);
          return save([...parts.values()].join(''));
        }
        if (type === 'result') {
          completed = event.subtype === 'success' && event.is_error === false && event.stop_reason !== 'max_tokens';
          if (event.is_error === true || event.subtype !== 'success') {
            reportedError = true;
            failure = requestError(source, string(event.result) ?? array(event.errors).filter((item) => typeof item === 'string').join(' '));
          } else if (typeof event.result === 'string' && event.result) return save(event.result);
        }
      } else if (source === 'opencode') {
        if (type === 'text' && typeof part.text === 'string') return save(sample.raw + part.text);
        if (type === 'step_finish') completed = part.reason === 'stop' || part.reason === undefined;
      } else {
        if (type === 'text' && typeof event.text === 'string') return save(sample.raw + event.text);
        if (type === 'final') {
          const reason = object(event.reason);
          completed = reason.kind === 'completed';
          if (!completed) failure = requestError(source, JSON.stringify(reason));
          if (typeof event.text === 'string' && event.text) return save(event.text);
        }
      }
      if (type === 'error') {
        reportedError = true;
        failure = requestError(source, string(event.message) ?? JSON.stringify(object(event.error)));
      }
    },
    outcome(code: number | null, stderr: string) {
      if (failure || reportedError || code !== 0 || !completed || !sample.raw.trim() || !sample.threadId) {
        return failure ?? requestError(source, stderr) ?? `${sources[source].title} 未返回可确认的完整会话与助手文本。请检查 CLI 配置后重试。`;
      }
      return null;
    },
  };
}

async function collectSample(client: ReadyClient, model: ModelChoice, sample: SampleEvidence, options: CollectOptions) {
  const { signal, update } = options;
  const started = performance.now();
  sample.status = 'running';
  update();
  try {
    await withEmptyDirectory(async (cwd) => {
      const events = clientEvents(client.source, sample, update);
      const run = (args: string[], input?: string) => runCommand(client.command, args, cwd, signal, {
        env: isolatedEnvironment(cwd), input, timeoutMs: options.timeoutMs ?? SAMPLE_TIMEOUT_MS, onLine: events.onLine,
      });
      const result = client.source === 'claude-code'
        ? await run(CLAUDE_FLAGS, sample.prompt)
        : client.source === 'opencode'
          ? await withConfig(cwd, 'opencode.json', OPEN_CODE_CONFIG,
            () => run(['--standalone', 'run', '--format', 'json', '--archived', '--agent', OPEN_CODE_AGENT, '--model', model.id], sample.prompt))
          : await withConfig(cwd, 'fingerprint.patch.yml', client.dshRows?.map((id) => ({ id, disabled: true })) ?? [],
            (path) => run([...DSH_PROFILE, '--patch', path, '--permission-mode', 'read-only', '--approval-policy', 'never', '--json', '-'], sample.prompt));
      if (signal.aborted) sample.status = 'cancelled';
      else if (result.timedOut) {
        sample.status = 'timeout';
        sample.error = '采样达到等待时限。';
      } else {
        sample.error = result.oversized ? '客户端事件超过应用的大小限制。' : events.outcome(result.code, result.stderr);
        sample.status = sample.error ? 'failed' : 'received';
      }
    });
  } catch {
    sample.status = signal.aborted ? 'cancelled' : 'failed';
    if (!signal.aborted) sample.error = '无法创建隔离目录或启动客户端进程。';
  } finally {
    sample.durationMs = Math.round(performance.now() - started);
    update();
  }
}

export async function collectClient(client: ReadyClient, model: ModelChoice, detection: Detection, options: CollectOptions) {
  const reference = options.bank();
  await Promise.all(detection.samples.map((sample) => collectSample(client, model, sample, options)));
  finishDetection(detection, options, reference ?? options.bank());
  options.update();
}
