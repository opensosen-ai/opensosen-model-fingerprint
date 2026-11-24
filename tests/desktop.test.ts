import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import type { Detector, Output } from 'lmfpd-sdk';
import { emptySnapshot } from './bank-snapshot.js';
import { ReferenceBank } from '../src/bank.js';
import { verifyCache } from '../src/bank-integrity.js';
import { accountMode, chooseRoute, emptyConnection, sameAccount, type ReadyCodex } from '../src/codex.js';
import { findCodex, savedLoginEnvironment } from '../src/codex-process.js';
import { CodexSelection } from '../src/codex-selection.js';
import { finishDetection, makeDetection, sampleArgs, textOnlyModel, type CollectOptions } from '../src/collect.js';
import type { ModelChoice } from '../src/types.js';

const gateway = {
  defaultProviderId: 'gateway',
  data: [{ id: 'gateway', baseUrl: 'https://gateway.example.test/v1', settings: { type: 'customGateway', auth: { mode: 'externallyConfigured', envKey: null } } }],
};
const official = {
  defaultProviderId: 'openai',
  data: [{ id: 'openai', baseUrl: null, settings: { type: 'openai' } }],
};
const model: ModelChoice = { id: 'gpt-test', title: 'GPT Test', effort: 'low', isDefault: true };

function readyFrom(account: 'apiKey' | 'chatgpt'): ReadyCodex {
  const { route, config } = chooseRoute(account, gateway, official, account === 'apiKey');
  return {
    executable: 'codex.exe', routeConfig: config, bundled: new Map(),
    connection: { ...emptyConnection('ready'), state: 'ready', account, version: '0.171.0', configuredProvider: 'gateway', route, models: [model] },
  };
}

test('manual Codex selection survives restart, never falls back when missing, and can return to PATH', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'opensosen-codex-selection-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const automatic = join(dir, 'codex.exe');
  const explicit = join(dir, 'custom codex.exe');
  await writeFile(automatic, 'fixture');
  await writeFile(explicit, 'fixture');
  const originalPath = process.env.Path;
  process.env.Path = dir;
  t.after(() => { if (originalPath === undefined) delete process.env.Path; else process.env.Path = originalPath; });
  const file = join(dir, 'settings', 'codex-selection.json');
  const selection = new CodexSelection(file);
  await selection.load();
  assert.equal(await findCodex(selection.path), automatic);
  await selection.save(explicit);
  const reopened = new CodexSelection(file);
  await reopened.load();
  assert.equal(await findCodex(reopened.path), explicit);
  await rm(explicit);
  assert.equal(await findCodex(reopened.path), null);
  await reopened.save(null);
  const reset = new CodexSelection(file);
  await reset.load();
  assert.equal(await findCodex(reset.path), automatic);
});

test('invalid Codex selections do not replace the saved executable', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'opensosen-codex-selection-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const executable = join(dir, 'codex.exe');
  await writeFile(executable, 'fixture');
  const selection = new CodexSelection(join(dir, 'selection.json'));
  await selection.save(executable);
  const directory = join(dir, 'directory.exe');
  await mkdir(directory);
  for (const invalid of [directory, join(dir, 'missing.exe'), 'codex.exe', join(dir, 'codex.cmd')]) {
    await assert.rejects(selection.save(invalid));
    assert.equal(selection.path, executable);
  }
  const reopened = new CodexSelection(join(dir, 'selection.json'));
  await reopened.load();
  assert.equal(reopened.path, executable);
});

test('corrupt Codex settings require an explicit reset rather than silently selecting another program', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'opensosen-codex-selection-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'selection.json');
  await writeFile(file, '{broken');
  const selection = new CodexSelection(file);
  await assert.rejects(selection.load());
  await selection.save(null);
  const reopened = new CodexSelection(file);
  await reopened.load();
  assert.equal(reopened.path, null);
});
test('ChatGPT keeps the official endpoint and rejects an unconfirmed provider override', () => {
  const ready = readyFrom('chatgpt');
  assert.deepEqual(ready.connection.route, { kind: 'chatgpt', origin: 'https://chatgpt.com', provider: 'openai' });
  assert.equal(ready.routeConfig.openai_base_url, 'https://chatgpt.com/backend-api/codex');
  assert.throws(() => chooseRoute('chatgpt', gateway, gateway, true), /官方 ChatGPT 通道未验证/);
  assert.throws(() => chooseRoute('chatgpt', gateway, { ...official, data: [{ ...official.data[0], baseUrl: 'https://gateway.example.test' }] }, true), /官方 ChatGPT 通道未验证/);
});

test('API Key preserves the configured Responses path and rejects unprojectable gateway auth', () => {
  const ready = readyFrom('apiKey');
  assert.equal(ready.connection.route.kind, 'custom');
  assert.equal(ready.routeConfig['model_providers.gateway.base_url'], 'https://gateway.example.test/v1');
  assert.equal(ready.routeConfig['model_providers.gateway.requires_openai_auth'], true);
  assert.equal(ready.routeConfig['model_providers.gateway.request_max_retries'], 0);
  assert.equal(ready.routeConfig['model_providers.gateway.stream_max_retries'], 0);
  assert.throws(() => chooseRoute('apiKey', gateway, official, false));
  assert.throws(() => chooseRoute('signedOut', gateway, official, false));
  assert.throws(() => chooseRoute('apiKey', {
    ...gateway, data: [{ ...gateway.data[0], baseUrl: 'https://gateway.example.test/v1?credential=fixture' }],
  }, official, true));
});

test('Codex preserves explicit profiles and API-key safety while isolating SQLite for standalone launches', async (t) => {
  assert.equal(accountMode({ account: null }), 'signedOut');
  assert.equal(accountMode({ account: { type: 'gcp' } }), 'other');
  const chatgpt = { account: { type: 'chatgpt', workspaceName: 'Personal' }, userId: 'public-test-id' };
  assert(sameAccount(chatgpt, structuredClone(chatgpt)));
  assert(!sameAccount(chatgpt, { ...chatgpt, userId: 'another-test-id' }));
  assert(!sameAccount(chatgpt, { account: { type: 'apiKey' } }));

  const userProfile = await mkdtemp(join(tmpdir(), 'opensosen-codex-environment-'));
  t.after(() => rm(userProfile, { recursive: true, force: true }));
  const executable = join(userProfile, 'codex.exe');
  await writeFile(executable, 'first Codex build');
  const inherited: NodeJS.ProcessEnv = {
    Path: 'test-path', USERPROFILE: userProfile, LOCALAPPDATA: join(userProfile, 'Local'),
    CODEX_HOME: join(userProfile, '.codex'),
    Codex_Api_Key: 'fixture', OPENAI_API_KEY: 'fixture', CODEX_ACCESS_TOKEN: 'fixture',
  };
  const env = savedLoginEnvironment(inherited, executable);
  assert.equal(env.CODEX_HOME, inherited.CODEX_HOME);
  assert.equal(inherited.CODEX_SQLITE_HOME, undefined);
  const sqliteHome = env.CODEX_SQLITE_HOME!;
  assert.equal(relative(join(inherited.LOCALAPPDATA!, 'OpenSosen Model Fingerprint', 'sqlite'), sqliteHome).includes('..'), false);
  assert.equal((await stat(sqliteHome)).isDirectory(), true);
  assert.equal(savedLoginEnvironment(inherited, executable).CODEX_SQLITE_HOME, sqliteHome);
  await writeFile(executable, 'a different updated Codex build');
  assert.notEqual(savedLoginEnvironment(inherited, executable).CODEX_SQLITE_HOME, sqliteHome);

  const passed: Record<string, unknown> = {};
  for (const key in env) passed[key] = env[key];
  assert.deepEqual(passed, {
    Path: inherited.Path, USERPROFILE: userProfile, LOCALAPPDATA: inherited.LOCALAPPDATA,
    CODEX_HOME: inherited.CODEX_HOME, CODEX_SQLITE_HOME: sqliteHome,
  });

  const configuredSqliteHome = join(userProfile, 'project-sqlite');
  const explicit = savedLoginEnvironment({ ...inherited, CODEX_SQLITE_HOME: configuredSqliteHome }, executable);
  assert.equal(explicit.CODEX_SQLITE_HOME, configuredSqliteHome);
  const mixedCase = savedLoginEnvironment({ ...inherited, codex_sqlite_home: configuredSqliteHome }, executable);
  assert.equal(mixedCase.codex_sqlite_home, configuredSqliteHome);
  assert.equal(mixedCase.CODEX_SQLITE_HOME, undefined);
  const blank = savedLoginEnvironment({ ...inherited, codex_sqlite_home: ' ' }, executable);
  assert.equal(blank.codex_sqlite_home, savedLoginEnvironment(inherited, executable).CODEX_SQLITE_HOME);
  const defaultLogin = savedLoginEnvironment({ LOCALAPPDATA: inherited.LOCALAPPDATA, USERPROFILE: userProfile }, executable);
  assert.equal(defaultLogin.CODEX_HOME, undefined);
  await mkdir(join(userProfile, '.codex'));
  const existingLogin = savedLoginEnvironment({ LOCALAPPDATA: inherited.LOCALAPPDATA, USERPROFILE: userProfile }, executable);
  assert.equal(existingLogin.CODEX_HOME, join(userProfile, '.codex'));
  const withoutLocalAppData = savedLoginEnvironment({ USERPROFILE: userProfile }, executable);
  assert.equal(relative(join(userProfile, 'AppData', 'Local'), withoutLocalAppData.CODEX_SQLITE_HOME!).startsWith('..'), false);
});

test('sampling launches isolated text turns with distinct exact SDK challenges', () => {
  const ready = readyFrom('apiKey');
  const run = makeDetection(ready, model);
  const args = sampleArgs(ready, model, 'C:/test/models.json');
  assert.equal(new Set(run.samples.map((s) => s.expected)).size, 3);
  assert(run.samples.every((s) => s.expected >= 292 && s.expected <= 332 && s.prompt.includes(String(s.expected))));
  assert(run.samples.every((s) => !args.includes(s.prompt)));
  for (const expected of ['--ignore-user-config', '--ephemeral', 'features.shell_tool=false', 'features.plugins=false', 'web_search="disabled"', 'model_catalog_json="C:/test/models.json"', 'features.goals=false']) {
    assert(args.includes(expected), expected);
  }
  assert.equal(args.at(-1), '-');
});

test('model-supplied tools and instructions are removed without changing the requested model or transport', () => {
  const model = {
    slug: 'gpt-test', base_instructions: 'fixture', model_messages: { template: 'fixture' },
    use_responses_lite: true, tool_mode: 'code_mode_only', shell_type: 'unified_exec',
    apply_patch_tool_type: 'freeform', experimental_supported_tools: ['clock'], supports_parallel_tool_calls: true,
  };
  assert.deepEqual(textOnlyModel(model), {
    slug: 'gpt-test', base_instructions: '', model_messages: null, use_responses_lite: true,
    tool_mode: 'direct', shell_type: 'disabled', apply_patch_tool_type: null,
    experimental_supported_tools: [], supports_parallel_tool_calls: false,
  });
  assert.equal(model.tool_mode, 'code_mode_only');
});

test('partial scoring sees original received text, cancellation preserves evidence', () => {
  const run = makeDetection(readyFrom('apiKey'), model);
  const answer = '12, 63, 77\n';
  Object.assign(run.samples[0], { status: 'received', raw: answer, count: 3 });
  Object.assign(run.samples[1], { status: 'failed', raw: '2', count: 1 });
  Object.assign(run.samples[2], { status: 'timeout' });
  const controller = new AbortController();
  const calls: Output[][] = [];
  const reference = {
    info: { builtAt: 'fixture', sha256: 'fixture', modelCount: 0 },
    detector: { analyze: (outputs: Output[]) => { calls.push(outputs); return { decision: 'unscorable', results: [] }; } } as unknown as Detector,
  };
  const options: CollectOptions = { signal: controller.signal, update: () => {}, bank: () => reference };
  finishDetection(run, options, reference);
  assert.deepEqual(calls, [[{ text: answer, expected_count: run.samples[0].expected }]]);
  assert.equal(run.status, 'unscorable');
  assert.equal(run.samples[1].raw, '2');

  const cancelled = makeDetection(readyFrom('apiKey'), model);
  cancelled.samples[0] = { ...run.samples[0] };
  controller.abort();
  finishDetection(cancelled, options, reference);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.analysis, null);
  assert.equal(cancelled.samples[0].raw, answer);
  assert.equal(calls.length, 1);
});

test('failed, timed out, and unavailable reference runs retain their distinct states', () => {
  const run = makeDetection(readyFrom('apiKey'), model);
  const options: CollectOptions = { signal: new AbortController().signal, update: () => {}, bank: () => null };
  run.samples[0].status = 'failed';
  finishDetection(run, options, null);
  assert.equal(run.status, 'failed');
  run.samples[1].status = 'timeout';
  finishDetection(run, options, null);
  assert.equal(run.status, 'timeout');
  run.samples[2].status = 'received';
  run.samples[2].raw = '29, 9';
  finishDetection(run, options, null);
  assert.equal(run.status, 'bankUnavailable');
  assert.equal(run.analysis, null);
  assert.equal(run.samples[2].raw, '29, 9');
});

test('cache verification rejects a malformed header, changed manifest or altered detector', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'opensosen-bank-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'reference.bin');
  await writeFile(file, Buffer.from([255, 255, 255, 255]));
  await assert.rejects(verifyCache(file), /size limit/);
  await writeFile(file, Buffer.from([10, 0, 0, 0, 123]));
  await assert.rejects(verifyCache(file), /Incomplete/);
  const { cache, sha256, builtAt } = emptySnapshot();
  await writeFile(file, cache);
  assert.deepEqual(await verifyCache(file), { sha256, builtAt, modelCount: 0 });
  await assert.rejects(verifyCache(file, { sha256, builtAt, modelCount: 2 }), /changed/);
  cache[cache.length - 1] ^= 1;
  await writeFile(file, cache);
  await assert.rejects(verifyCache(file), /checksum mismatch/);
});

test('SDK updates install verified bytes, reject a corrupted replacement and reopen offline', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'opensosen-bank-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const first = emptySnapshot();
  const newer = emptySnapshot('2026-02-15T00:00:00Z');
  let manifest = first.manifest;
  let chunk = first.chunk;
  let online = true;
  t.mock.method(globalThis, 'fetch', async (resource: URL | string) => {
    if (!online) throw new Error('offline');
    if (String(resource).endsWith('/bundle.json')) return new Response(manifest);
    if (String(resource).endsWith('/chunks/empty.zst')) return new Response(Uint8Array.from(chunk));
    throw new Error('Unexpected request');
  });
  const bank = new ReferenceBank(dir, () => {});
  await bank.refresh();
  assert.equal(bank.state.state, 'ready');
  assert.equal(bank.state.info?.sha256, first.sha256);
  const cache = join(dir, 'reference.bin');
  assert.deepEqual(await readFile(cache), first.cache);
  // Advertise an incorrect checksum in the newer manifest. The decoded detector is
  // structurally valid, so this exercises our verification after the SDK loads it.
  manifest = newer.manifest.replace(newer.sha256, 'f'.repeat(64));
  chunk = newer.chunk;
  await bank.refresh();
  assert.equal(bank.state.info?.sha256, first.sha256);
  assert.deepEqual(await readFile(cache), first.cache);
  manifest = newer.manifest;
  await bank.refresh();
  assert.equal(bank.state.info?.sha256, newer.sha256);
  assert.deepEqual(await readFile(cache), newer.cache);
  online = false;
  const reopened = new ReferenceBank(dir, () => {});
  await reopened.refresh();
  assert.equal(reopened.state.state, 'ready');
  assert.equal(reopened.state.info?.sha256, newer.sha256);
  assert.ok(reopened.state.message);
});
