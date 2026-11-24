import type { Analysis } from 'lmfpd-sdk';

export const sources = {
  codex: { title: 'Codex', mode: 'automatic' },
  'claude-code': { title: 'Claude Code', mode: 'automatic' },
  'claude-desktop': { title: 'Claude Windows 桌面', mode: 'manual' },
  opencode: { title: 'OpenCode', mode: 'automatic' },
  'dsh-desktop': { title: 'DeepSeek Harness Windows 桌面', mode: 'manual' },
  'dsh-cli': { title: 'DeepSeek Harness CLI', mode: 'automatic' },
} as const;

export type Source = keyof typeof sources;
export type ManualSource = { [S in Source]: (typeof sources)[S]['mode'] extends 'manual' ? S : never }[Source];
export type CliSource = Exclude<Source, 'codex' | ManualSource>;

export function isManualSource(source: Source): source is ManualSource {
  return sources[source].mode === 'manual';
}

export type AccountMode = 'chatgpt' | 'apiKey' | 'signedOut' | 'other' | 'claude' | 'oauth' | 'clientConfigured';

export interface Route {
  provider: string;
  origin: string | null;
  kind: 'chatgpt' | 'openai-api' | 'custom' | 'client-config';
}

export interface ModelChoice {
  id: string;
  title: string;
  effort: string | null;
  isDefault: boolean;
  route?: Route | null;
  account?: AccountMode | null;
}

export interface CodexProbeDiagnostic {
  context: 'configured' | 'official' | 'storage-file' | 'storage-keyring';
  method: string;
  status: 'ok' | 'error';
  rpcCode: number | null;
  message: string | null;
}

export interface Connection {
  state: 'checking' | 'ready' | 'missing' | 'signedOut' | 'unsupported' | 'error';
  account: AccountMode | null;
  version: string | null;
  configuredProvider: string | null;
  route: Route | null;
  models: ModelChoice[];
  message: string | null;
  configuredExecutablePath: string | null;
  executablePath: string | null;
  note?: string;
  diagnostics?: CodexProbeDiagnostic[];
}

export interface BankInfo {
  builtAt: string;
  modelCount: number | null;
  sha256: string;
}

export interface BankState {
  state: 'checking' | 'ready' | 'unavailable';
  info: BankInfo | null;
  message: string | null;
}

export interface SampleEvidence {
  prompt: string;
  expected: number;
  count: number;
  status: 'queued' | 'running' | 'received' | 'failed' | 'cancelled' | 'timeout' | 'skipped';
  raw: string;
  threadId: string | null;
  clientModel?: string;
  durationMs: number | null;
  error: string | null;
}

export interface DetectionSource {
  source: Source;
  mode: 'automatic' | 'manual';
  clientVersion: string | null;
  codexVersion?: string;
  executablePath: string | null;
  account: AccountMode | null;
  model: string;
  effort: string | null;
  route: Route | null;
  transport: string;
  routeBasis: string;
  conditions: 'isolated-config' | 'agent-context-unverified' | 'manual-unverified';
  limitation: string | null;
  diagnostics?: CodexProbeDiagnostic[];
}

export interface Detection extends DetectionSource {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  sdk: '0.2.0';
  status: 'running' | 'scored' | 'partial' | 'unscorable' | 'not_model' | 'failed' | 'cancelled' | 'timeout' | 'bankUnavailable';
  samples: SampleEvidence[];
  bank: BankInfo | null;
  analysis: Analysis | null;
  message: string | null;
}

export interface DesktopState {
  source: Source;
  connection: Connection;
  bank: BankState;
  detection: Detection | null;
  changingCodex: boolean;
}

export interface DesktopApi {
  state(): Promise<DesktopState>;
  selectSource(source: Source): Promise<void>;
  refreshConnection(): Promise<void>;
  chooseCodex(): Promise<void>;
  usePathCodex(): Promise<void>;
  refreshBank(): Promise<void>;
  start(source: Source, model: string): Promise<boolean>;
  copyChallenge(index: number): Promise<boolean>;
  saveReply(index: number, text: string): Promise<boolean>;
  scoreReplies(): Promise<boolean>;
  cancel(): Promise<void>;
  exportEvidence(): Promise<{ path: string | null }>;
  onState(listener: (state: DesktopState) => void): void;
}
