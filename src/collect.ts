import { unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generateChallenges, parseNumbers, type Challenge, type Detector } from 'lmfpd-sdk';
import { CodexError, launch, messages, object, overrides, string, withEmptyDirectory, type Fields } from './codex-process.js';
import type { ReadyCodex } from './codex.js';
import type { BankInfo, Detection, ModelChoice, SampleEvidence } from './types.js';

export const SAMPLE_TIMEOUT_MS = 120_000;
const MAX_REPLY_LENGTH = 256 * 1024;

// CLI-local config. The `--ignore-user-config` switch is required because an
// empty MCP table alone merges with inherited server entries in app-server.
const TEXT_ONLY = {
  approval_policy: 'never',
  web_search: 'disabled',
  include_environment_context: false,
  include_collaboration_mode_instructions: false,
  include_permissions_instructions: false,
  include_apps_instructions: false,
  instructions: '',
  developer_instructions: '',
  project_doc_max_bytes: 0,
  'analytics.enabled': false,
  'agents.enabled': false,
  'skills.include_instructions': false,
  'tools.experimental_request_user_input.enabled': false,
  'tools.update_plan.enabled': false,
  'features.apps': false,
  'features.browser_use': false,
  'features.code_mode': false,
  'features.code_mode_only': false,
  'features.computer_use': false,
  'features.current_time_reminder': false,
  'features.deferred_executor': false,
  'features.deferred_tool_world_state': false,
  'features.goals': false,
  'features.hooks': false,
  'features.image_generation': false,
  'features.incremental_tools': false,
  'features.incremental_tools_legacy': false,
  'features.memory_tool': false,
  'features.multi_agent_v2': false,
  'features.plugins': false,
  'features.request_permissions_tool': false,
  'features.send_message_to_user_async': false,
  'features.shell_snapshot': false,
  'features.shell_tool': false,
  'features.skill_search': false,
  'features.sleep_tool': false,
  'features.token_budget': false,
  'features.tool_suggest': false,
  'features.view_image': false,
};

const DISALLOWED_ITEMS = new Set([
  'command_execution', 'file_change', 'mcp_tool_call', 'web_search', 'todo_list',
  'collab_tool_call', 'dynamic_tool_call', 'image_generation', 'subagent_activity',
]);

export function textOnlyModel(entry: Fields): Fields {
  // Codex's built-in catalog can enable tools even when features are off.
  // Keep the same slug, reasoning options and transport for a text-only turn.
  return {
    ...entry,
    base_instructions: '',
    model_messages: null,
    tool_mode: 'direct',
    shell_type: 'disabled',
    apply_patch_tool_type: null,
    experimental_supported_tools: [],
    supports_parallel_tool_calls: false,
  };
}

export function sampleArgs(codex: ReadyCodex, model: ModelChoice, catalogPath: string) {
  return [
    'exec', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--ignore-rules',
    '--json', '--color', 'never', '--sandbox', 'read-only', '--model', model.id,
    ...overrides({
      ...TEXT_ONLY,
      ...codex.routeConfig,
      model_catalog_json: catalogPath,
      ...(model.effort ? { model_reasoning_effort: model.effort } : {}),
    }),
    '-',
  ];
}

function turnError(value: unknown) {
  const message = string(value) ?? '';
  const status = message.match(/\b(400|401|403|404|408|409|422|429|500|502|503|504)\b/)?.[0];
  if (status) return `模型服务请求失败（HTTP ${status}）。`;
  if (/model.*(?:not supported|unavailable|not found)|unknown model/i.test(message)) return '提供方拒绝了所选模型。';
  if (/login|log in|credential|authentication|api key|unauthorized/i.test(message)) return 'Codex 未能通过提供方认证。请在官方客户端检查登录和路由。';
  if (/timed? out|timeout/i.test(message)) return '模型服务连接超时。';
  return 'Codex 报告采样失败。可在官方客户端检查该模型和提供方。';
}

export interface CollectOptions {
  signal: AbortSignal;
  timeoutMs?: number;
  update: () => void;
  bank: () => { detector: Detector; info: BankInfo } | null;
}

export function makeDetection(codex: ReadyCodex, model: ModelChoice): Detection {
  return {
    id: crypto.randomUUID(), startedAt: new Date().toISOString(), finishedAt: null,
    codexVersion: codex.connection.version, executablePath: codex.executable, sdk: '0.2.0', account: codex.connection.account,
    model: model.id, effort: model.effort, route: codex.connection.route, transport: 'codex exec --json',
    status: 'running', bank: null, analysis: null, message: null,
    samples: generateChallenges(3).map((challenge: Challenge) => ({
      prompt: challenge.prompt, expected: challenge.expected_count, count: 0, status: 'queued',
      raw: '', threadId: null, durationMs: null, error: null,
    })),
  };
}

async function collectSample(codex: ReadyCodex, model: ModelChoice, catalogPath: string, sample: SampleEvidence, options: CollectOptions) {
  const { signal, update } = options;
  const started = performance.now();
  if (signal.aborted) {
    sample.status = 'cancelled';
    update();
    return;
  }
  sample.status = 'running';
  update();

  try {
    await withEmptyDirectory(async (cwd) => {
      if (signal.aborted) {
        sample.status = 'cancelled';
        return;
      }
      const child = launch(codex.executable, sampleArgs(codex, model, catalogPath), cwd);
      let completed = false;
      let failure: string | null = null;
      let timedOut = false;
      const replies = new Map<string, string>();
      const stop = () => child.kill();
      signal.addEventListener('abort', stop, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, options.timeoutMs ?? SAMPLE_TIMEOUT_MS);

      const lines = messages(child, (event) => {
        if (event.type === 'thread.started') {
          const id = string(event.thread_id);
          if (id && /^[a-zA-Z0-9_-]{1,100}$/.test(id)) sample.threadId = id;
        }
        if (event.type === 'turn.completed') completed = true;
        if (event.type === 'turn.failed') failure = turnError(object(event.error).message);
        const item = object(event.item);
        const type = string(item.type);
        if (type && DISALLOWED_ITEMS.has(type)) {
          failure = 'Codex 报告工具活动。此样本停止采集，排除评分。';
          stop();
        }
        if (type !== 'agent_message' || !['item.updated', 'item.completed'].includes(String(event.type))) return;
        const text = string(item.text);
        if (text === null) return;
        replies.set(string(item.id) ?? '', text);
        const raw = [...replies.values()].join('\n');
        if (raw.length > MAX_REPLY_LENGTH) {
          failure = '回复超过应用的证据大小限制。';
          stop();
          return;
        }
        sample.raw = raw;
        sample.count = parseNumbers(raw).length;
        update();
      });
      child.once('error', () => { failure = '无法启动本机 Codex 采样进程。'; });
      const closed = new Promise<number | null>((resolve) => child.once('close', resolve));
      child.stdin.end(sample.prompt);
      if (signal.aborted) stop();
      const code = await closed;
      lines.close();
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);

      if (signal.aborted) sample.status = 'cancelled';
      else if (timedOut) {
        sample.status = 'timeout';
        sample.error = '采样达到等待时限。';
      } else if (failure || code !== 0 || !completed || !sample.raw) {
        sample.status = 'failed';
        sample.error = failure ?? (completed && !sample.raw ? 'Codex 结束了该轮，但没有返回助手文本。' : 'Codex 采样进程未完成。');
      } else sample.status = 'received';
    });
  } catch {
    sample.status = signal.aborted ? 'cancelled' : 'failed';
    if (!signal.aborted) sample.error = '无法创建独立采样环境或启动 Codex。';
  } finally {
    sample.durationMs = Math.round(performance.now() - started);
    update();
  }
}

export function finishDetection(detection: Detection, options: CollectOptions, reference: ReturnType<CollectOptions['bank']>) {
  detection.finishedAt = new Date().toISOString();
  detection.bank = reference?.info ?? null;
  if (options.signal.aborted) {
    detection.status = 'cancelled';
    return;
  }
  const received = detection.samples.filter((sample) => sample.status === 'received');
  if (!received.length) {
    detection.status = detection.samples.some((sample) => sample.status === 'timeout') ? 'timeout' : 'failed';
    return;
  }
  if (!reference) {
    detection.status = 'bankUnavailable';
    return;
  }
  try {
    const analysis = reference.detector.analyze(received.map((sample) => ({ text: sample.raw, expected_count: sample.expected })));
    detection.analysis = analysis;
    detection.status = analysis.decision;
  } catch {
    detection.status = 'failed';
    detection.message = '参考库评分失败。原始样本仍可导出。';
  }
}

export async function collect(codex: ReadyCodex, model: ModelChoice, detection: Detection, options: CollectOptions) {
  const entry = codex.bundled.get(model.id);
  if (!entry) throw new CodexError('所选模型缺少可确认的纯文本配置。');
  const reference = options.bank();
  await withEmptyDirectory(async (dir) => {
    const catalogPath = join(dir, 'models.json');
    try {
      await writeFile(catalogPath, JSON.stringify({ models: [textOnlyModel(entry)] }), { flag: 'wx' });
      await Promise.all(detection.samples.map((sample) => collectSample(codex, model, catalogPath, sample, options)));
    } finally {
      await unlink(catalogPath).catch(() => {});
    }
  });
  finishDetection(detection, options, reference ?? options.bank());
  options.update();
}
