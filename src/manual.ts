import { join } from 'node:path';
import { parseNumbers } from 'lmfpd-sdk';
import { createDetection, finishDetection, MAX_REPLY_LENGTH, type CollectOptions } from './collect.js';
import { commandOutput } from './cli-process.js';
import type { Connection, Detection, ManualSource } from './types.js';

const LIMITATION = '手动粘贴的参考库比较。账号、路由、工具和会话上下文均未经程序核验。';

export async function inspectManual(source: ManualSource, signal: AbortSignal): Promise<Connection> {
  const powershell = join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const script = source === 'claude-desktop'
    ? '(Get-AppxPackage -Name Claude | Select-Object -First 1).Version'
    : `$candidates = @((Join-Path $env:LOCALAPPDATA 'Programs/DeepSeek Harness/DeepSeek Harness.exe'), (Join-Path $env:ProgramFiles 'DeepSeek Harness/DeepSeek Harness.exe'))
       foreach ($file in $candidates) {
         if (Test-Path -LiteralPath $file -PathType Leaf) { (Get-Item -LiteralPath $file).VersionInfo.FileVersion; break }
       }`;
  const result = await commandOutput({ file: powershell, prefix: [] },
    ['-NoProfile', '-NonInteractive', '-Command', script], process.env.SystemRoot ?? 'C:/Windows', signal, 5_000);
  signal.throwIfAborted();
  const version = result.stdout.match(/\b\d+\.\d+\.\d+(?:\.\d+|-[\w.-]+)?\b/)?.[0] ?? null;
  return {
    state: 'ready', account: null, version, configuredProvider: null, route: null, models: [], message: null,
    configuredExecutablePath: null, executablePath: null,
    note: source === 'claude-desktop'
      ? '手动采样。Claude Code 的 --desktop 入口用于打开界面或移交会话。'
      : '手动采样。桌面保留的 desktop 配置只由图形应用启动。',
  };
}

export function makeManualDetection(source: ManualSource, version: string | null, model: string) {
  return createDetection({
    source, mode: 'manual', clientVersion: version, executablePath: null, account: null,
    model: model.trim().slice(0, 120) || '未填写', effort: null, route: null,
    transport: '用户手动复制挑战并粘贴回复', routeBasis: '由用户选择来源，路由未核验',
    conditions: 'manual-unverified', limitation: LIMITATION,
  });
}

export function saveManualReply(run: Detection, index: unknown, raw: unknown) {
  if (run.mode !== 'manual' || run.status !== 'running' || typeof index !== 'number' || !Number.isInteger(index) ||
    typeof raw !== 'string' || !raw.trim() || raw.length > MAX_REPLY_LENGTH) return false;
  const sample = run.samples[index];
  if (!sample) return false;
  Object.assign(sample, { status: 'received', raw, count: parseNumbers(raw).length });
  return true;
}

export function finishManual(run: Detection, options: CollectOptions) {
  if (run.mode !== 'manual' || run.status !== 'running') return false;
  if (!options.signal.aborted && !run.samples.some(({ status }) => status === 'received')) return false;
  for (const sample of run.samples) {
    if (sample.status === 'queued') sample.status = options.signal.aborted ? 'cancelled' : 'skipped';
  }
  finishDetection(run, options, options.bank());
  options.update();
  return true;
}
