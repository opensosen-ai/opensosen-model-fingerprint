import { execFile, spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import type { CliSource } from './types.js';

export interface Command {
  file: string;
  prefix: string[];
}

const names: Record<CliSource, string> = { 'claude-code': 'claude', opencode: 'opencode', 'dsh-cli': 'dsh' };

async function exists(file: string) {
  return (await stat(file).catch(() => null))?.isFile() === true;
}

export async function findCommand(source: CliSource, env: NodeJS.ProcessEnv = process.env): Promise<Command | null> {
  const paths = (env.PATH ?? env.Path ?? '').split(delimiter).map((path) => path.trim().replace(/^"|"$/g, '')).filter(isAbsolute);
  if (source === 'claude-code' && env.USERPROFILE) paths.push(join(env.USERPROFILE, '.local', 'bin'));
  if (source !== 'claude-code' && env.APPDATA) paths.push(join(env.APPDATA, 'npm'));
  for (const path of new Set(paths)) {
    const name = names[source];
    const nativeFile = join(path, `${name}.exe`);
    if (await exists(nativeFile)) return { file: nativeFile, prefix: [] };
    if (source === 'claude-code' || !await exists(join(path, `${name}.cmd`))) continue;
    // Resolve known Windows npm shims to their packaged entry. Only the argument
    // vector is passed to the client. A shell never interprets models or prompts.
    if (source === 'opencode') {
      const file = join(path, 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe');
      if (await exists(file)) return { file, prefix: [] };
    } else {
      const bin = join(path, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
      if (!await exists(bin)) continue;
      for (const nodePath of [path, ...paths]) {
        const file = join(nodePath, 'node.exe');
        if (await exists(file)) return { file, prefix: [bin] };
      }
    }
  }
  return null;
}

interface RunOptions {
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs: number;
  onLine?: (line: string) => boolean | void;
}

export function runCommand(command: Command, args: string[], cwd: string, signal: AbortSignal, options: RunOptions) {
  signal.throwIfAborted();
  const child = spawn(command.file, [...command.prefix, ...args], {
    cwd, env: options.env, windowsHide: true, stdio: 'pipe',
  });
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let oversized = false;
  let stopping = false;
  const stop = () => {
    if (stopping || child.exitCode !== null || child.signalCode !== null) return;
    stopping = true;
    if (process.platform === 'win32' && child.pid) {
      const taskkill = join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'taskkill.exe');
      execFile(taskkill, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 3_000 }, () => {
        if (child.exitCode === null && child.signalCode === null) child.kill();
      });
    } else child.kill();
  };
  const timer = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs);
  const limit = 2 * 1024 * 1024;
  child.stdin.on('error', () => {});
  child.stdout.setEncoding('utf8').on('data', (text: string) => {
    if (stopping) return;
    stdout += text;
    if (stdout.length > limit) { oversized = true; stop(); return; }
    if (!options.onLine) return;
    const lines = stdout.split('\n');
    stdout = lines.pop() ?? '';
    for (const line of lines) {
      if (options.onLine(line.trimEnd()) === false) { stop(); break; }
    }
  });
  child.stderr.setEncoding('utf8').on('data', (text: string) => {
    // Used only to recognize known public error categories in memory.
    stderr = (stderr + text).slice(-16_384);
  });
  child.on('error', () => {});
  const done = new Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean; oversized: boolean }>((resolve) => {
    child.once('close', (code) => {
      if (!stopping && options.onLine && stdout.trim()) options.onLine(stdout.trimEnd());
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      resolve({ code, stdout: options.onLine ? '' : stdout, stderr, timedOut, oversized });
    });
  });
  signal.addEventListener('abort', stop, { once: true });
  child.stdin.end(options.input);
  if (signal.aborted) stop();
  return done;
}

export function commandOutput(command: Command, args: string[], cwd: string, signal: AbortSignal, timeoutMs = 20_000, env?: NodeJS.ProcessEnv) {
  return runCommand(command, args, cwd, signal, { timeoutMs, env });
}
