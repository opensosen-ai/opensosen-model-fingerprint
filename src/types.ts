import type { Analysis } from 'lmfpd-sdk';

export type AccountMode = 'chatgpt' | 'apiKey' | 'signedOut' | 'other';

export interface Route {
  provider: string;
  origin: string;
  kind: 'chatgpt' | 'openai-api' | 'custom';
}

export interface ModelChoice {
  id: string;
  title: string;
  effort: string | null;
  isDefault: boolean;
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
  status: 'queued' | 'running' | 'received' | 'failed' | 'cancelled' | 'timeout';
  raw: string;
  threadId: string | null;
  durationMs: number | null;
  error: string | null;
}

export interface Detection {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  codexVersion: string;
  executablePath: string;
  sdk: '0.2.0';
  account: AccountMode;
  model: string;
  effort: string | null;
  route: Route;
  transport: 'codex exec --json';
  status: 'running' | 'scored' | 'partial' | 'unscorable' | 'not_model' | 'failed' | 'cancelled' | 'timeout' | 'bankUnavailable';
  samples: SampleEvidence[];
  bank: BankInfo | null;
  analysis: Analysis | null;
  message: string | null;
}

export interface DesktopState {
  connection: Connection;
  bank: BankState;
  detection: Detection | null;
  changingCodex: boolean;
}

export interface DesktopApi {
  state(): Promise<DesktopState>;
  refreshConnection(): Promise<void>;
  chooseCodex(): Promise<void>;
  usePathCodex(): Promise<void>;
  refreshBank(): Promise<void>;
  start(model: string): Promise<boolean>;
  cancel(): Promise<void>;
  exportEvidence(): Promise<{ path: string | null }>;
  onState(listener: (state: DesktopState) => void): void;
}
