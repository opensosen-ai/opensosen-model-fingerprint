import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rmdir, unlink, utimes, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { zstdDecompressSync } from 'node:zlib';

const [appExe, codexExe, bankFile, evidence] = process.argv.slice(2).map((arg) => resolve(arg));
assert(appExe && codexExe && bankFile && evidence,
  'Usage: node tests/verify-packaged.mjs <extracted app exe> <Codex exe> <verified reference.bin> <evidence directory>');
const root = await realpath(await mkdtemp(join(tmpdir(), 'opensosen-packaged-')));
await mkdir(evidence, { recursive: true });
const report = { mode: 'offline loopback fixture', appExe, date: new Date().toISOString(), checks: [], requests: [] };
const evidencePath = join(evidence, 'packaged-regression.json');
const userData = join(root, 'userdata');
const configFile = join(userData, 'codex-selection.json');
const codexHome = join(root, 'codex-home');
const localData = join(root, 'local');
const fixture = join(root, 'selected runtime');
const selected = join(fixture, 'codex.exe');
const fakeKey = 'sk-opensosen-packaged-fixture';
const picked = fileURLToPath(new URL('./native-codex-picker.ps1', import.meta.url));
const digest = (text) => createHash('sha256').update(text).digest('hex');
let hold = false;

async function waitFor(read, description, timeout = 25_000) {
  const until = Date.now() + timeout;
  do {
    let value;
    try { value = await read(); } catch (error) { if (error.name === 'AssertionError') throw error; }
    if (value) return value;
    await delay(80);
  } while (Date.now() < until);
  throw new Error('Timed out waiting for ' + description);
}

function fixtureReply(expected) {
  return Array.from({ length: expected }, (_, index) => (index * 71 + expected * 13 + index * index * 17) % 355 + 1).join(', ');
}

const gateway = createServer(async (req, res) => {
  if (req.method !== 'POST' || !req.url.endsWith('/responses')) { res.end('{}'); return; }
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let bytes = Buffer.concat(chunks);
    if (req.headers['content-encoding'] === 'zstd') bytes = zstdDecompressSync(bytes);
    const body = JSON.parse(bytes.toString());
    const prompts = body.input.filter((item) => item.role === 'user').flatMap((item) => item.content.map((part) => part.text));
    const expected = Number(prompts[0]?.match(/(?<![0-9])(29[2-9]|3[0-2][0-9]|33[0-2])(?![0-9])/)?.[1]);
    assert(expected >= 292 && expected <= 332);
    const entry = {
      model: body.model, path: req.url, users: prompts.length, tools: body.tools?.length ?? 0, instructions: body.instructions ?? null,
      promptSha256: digest(prompts[0]), expected, fixtureKey: req.headers.authorization === 'Bearer ' + fakeKey,
      held: hold, closed: false,
    };
    report.requests.push(entry);
    res.once('close', () => { entry.closed = true; });
    if (hold) return;
    const message = {
      id: 'msg_fixture', type: 'message', status: 'completed', role: 'assistant',
      content: [{ type: 'output_text', text: fixtureReply(expected), annotations: [] }],
    };
    const response = {
      id: 'resp_fixture', object: 'response', created_at: Math.floor(Date.now() / 1000),
      status: 'completed', model: body.model, output: [message],
      usage: { input_tokens: 200, input_tokens_details: { cached_tokens: 0 }, output_tokens: 500,
        output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 700 },
    };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (event) => res.write('event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n');
    emit({ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } });
    emit({ type: 'response.output_item.added', output_index: 0, item: { ...message, status: 'in_progress', content: [] } });
    emit({ type: 'response.output_item.done', output_index: 0, item: message });
    emit({ type: 'response.completed', response });
    res.end();
  } catch (error) {
    report.gatewayError = error.message;
    res.writeHead(400).end('{}');
  }
});

await new Promise((ready) => gateway.listen(0, '127.0.0.1', ready));
const route = 'http://127.0.0.1:' + gateway.address().port;
await Promise.all([mkdir(join(userData, 'reference'), { recursive: true }), mkdir(codexHome), mkdir(localData), mkdir(fixture)]);
await Promise.all([
  copyFile(bankFile, join(userData, 'reference', 'reference.bin')),
  copyFile(codexExe, selected),
  writeFile(configFile, '{invalid-json'),
  writeFile(join(codexHome, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: fakeKey })),
  writeFile(join(codexHome, 'config.toml'),
    'model = "gpt-6.2-sol"\nmodel_provider = "loopback"\ncli_auth_credentials_store = "file"\n' +
    '[model_providers.loopback]\nname = "Loopback"\nbase_url = "' + route + '/v1"\nwire_api = "responses"\n' +
    'requires_openai_auth = true\nrequest_max_retries = 0\nstream_max_retries = 0\n'),
]);
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(CODEX|OPENAI|ELECTRON_RUN_AS_NODE|PATH|APPDATA|LOCALAPPDATA|TEMP|TMP|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)/i.test(name)));
Object.assign(env, {
  Path: dirname(codexExe), CODEX_HOME: codexHome, LOCALAPPDATA: localData, APPDATA: root, TEMP: root, TMP: root,
  HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost',
});

async function desktop(work) {
  const portFile = join(userData, 'DevToolsActivePort');
  await unlink(portFile).catch(() => {});
  const child = spawn(appExe, ['--user-data-dir=' + userData, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'],
    { cwd: root, env, windowsHide: true, stdio: 'ignore' });
  child.on('error', () => {});
  const ended = new Promise((done) => child.once('close', done));
  let socket;
  try {
    const url = await waitFor(async () => {
      const port = Number((await readFile(portFile, 'utf8')).split(/\r?\n/)[0]);
      const pages = await fetch('http://127.0.0.1:' + port + '/json/list', { signal: AbortSignal.timeout(1000) }).then((r) => r.json());
      return pages.find((page) => page.type === 'page')?.webSocketDebuggerUrl;
    }, 'extracted Windows app window');
    socket = new WebSocket(url);
    await new Promise((open, fail) => { socket.addEventListener('open', open, { once: true }); socket.addEventListener('error', fail, { once: true }); });
    const pending = new Map();
    let next = 0;
    socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data);
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    });
    async function send(method, params = {}) {
      const id = ++next;
      const reply = new Promise((done) => pending.set(id, done));
      socket.send(JSON.stringify({ id, method, params }));
      const message = await Promise.race([reply, delay(8_000).then(() => ({ error: { message: method + ' timed out' } }))]);
      assert(!message.error, message.error?.message);
      return message.result;
    }
    async function evaluate(expression) {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      assert(!result.exceptionDetails, result.exceptionDetails?.exception?.description);
      return result.result.value;
    }
    await waitFor(() => evaluate('typeof window.fingerprint?.state === "function"'), 'application preload');
    const state = () => evaluate('fingerprint.state()');
    const settled = () => waitFor(async () => {
      const current = await state();
      return current.connection.state !== 'checking' && !current.changingCodex && current;
    }, 'connection');
    async function click(selector) {
      assert.equal(await evaluate('(() => { const el=document.querySelector(' + JSON.stringify(selector) +
        '); if(!el || el.disabled || !el.getClientRects().length) return false; el.click(); return true; })()'), true, selector);
    }
    async function input(selector, value) {
      await evaluate('(() => { const el=document.querySelector(' + JSON.stringify(selector) + '); el.value=' +
        JSON.stringify(value) + '; el.dispatchEvent(new Event("input",{bubbles:true})); el.dispatchEvent(new Event("change",{bubbles:true})); })()');
    }
    async function screenshot(name) {
      const data = await send('Page.captureScreenshot', { format: 'png' });
      await writeFile(join(evidence, name + '.png'), Buffer.from(data.data, 'base64'));
    }
    async function picker(path = null) {
      await click('#choose-codex');
      const request = join(root, 'picker.json');
      await writeFile(request, JSON.stringify({ pid: child.pid, pick: path }));
      const powershell = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
      await promisify(execFile)(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', picked, '-Request', request],
        { timeout: 23_000, windowsHide: true });
      return settled();
    }
    await work({ click, evaluate, input, picker, screenshot, settled, state });
    await evaluate('setTimeout(() => window.close(), 0); true');
  } finally {
    socket?.close();
    if (await Promise.race([ended.then(() => false), delay(4_000, true)])) child.kill();
    await ended;
  }
}

async function exportRun(gui, run, name) {
  await gui.click('#export');
  const path = await waitFor(() => gui.evaluate('document.querySelector("#export-message").textContent.match(/^已保存 (.+)$/)?.[1]'), 'JSON export');
  const body = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(body.format, 'opensosen-model-fingerprint-v2');
  assert.equal(body.detection.id, run.id);
  await copyFile(path, join(evidence, name + '.json'));
  await unlink(path);
}

async function accountProbeCases() {
  const fixtureExe = join(root, 'codex-rpc-fixture.exe');
  const compiler = join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  const fixtureSource = fileURLToPath(new URL('./CodexRpcFixture.cs', import.meta.url));
  await promisify(execFile)(compiler, ['/nologo', '/codepage:65001', '/r:System.Web.Extensions.dll', '/out:' + fixtureExe, fixtureSource],
    { windowsHide: true, timeout: 20_000 });
  const control = join(root, 'rpc-case.txt');
  const traceDir = join(root, 'rpc-trace');
  await mkdir(traceDir);
  await writeFile(configFile, JSON.stringify({ executable: fixtureExe }));
  Object.assign(env, { FINGERPRINT_FIXTURE_CASE: control, FINGERPRINT_FIXTURE_TRACE: traceDir });
  const readTrace = async () => {
    const files = await readdir(traceDir);
    const lines = await Promise.all(files.map((file) => readFile(join(traceDir, file), 'utf8')));
    return lines.join('\n').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  };
  const cases = [
    { label: 'chatgpt-healthy', ready: true },
    { label: 'configured-account-refused', ready: true, failed: [['configured', 'account/read']] },
    { label: 'configured-provider-refused', ready: true, failed: [['configured', 'modelProvider/list']] },
    { label: 'official-account-refused', ready: false, failed: [['official', 'account/read']] },
    { label: 'both-accounts-refused', ready: false, failed: [['configured', 'account/read'], ['official', 'account/read']] },
    { label: 'official-models-refused', ready: false, failed: [['official', 'model/list']] },
    { label: 'official-route-unconfirmed', ready: false },
    { label: 'account-conflict', ready: false },
    { label: 'api-healthy', ready: true, api: true },
    { label: 'api-official-refused', ready: true, api: true, failed: [['official', 'account/read']] },
  ];
  await writeFile(control, cases[0].label);
  const results = [];
  await desktop(async (gui) => {
    for (const [index, entry] of cases.entries()) {
      if (index) {
        await writeFile(control, entry.label);
        await gui.click('#refresh');
      }
      const { connection } = await gui.settled();
      assert.equal(connection.state, entry.ready ? 'ready' : 'error', entry.label);
      const failures = connection.diagnostics.filter(({ status }) => status === 'error');
      assert.equal(failures.length, entry.failed?.length ?? 0, entry.label);
      for (const [context, method] of entry.failed ?? []) {
        assert(failures.some((event) => event.context === context && event.method === method && event.rpcCode === -32600), entry.label);
      }
      assert.equal(await gui.evaluate('document.querySelector("#probe-diagnostics").hidden'), !failures.length);
      if (entry.label === 'configured-account-refused') {
        await gui.click('#probe-diagnostics > summary');
        assert.match(await gui.evaluate('document.querySelector("#probe-failures").textContent'), /当前配置.*account\/read.*-32600/);
        await gui.screenshot('codex-independent-account-probes');
      }
      const prior = (await gui.state()).detection?.id;
      let run;
      if (entry.ready) {
        assert.equal(connection.account, entry.api ? 'apiKey' : 'chatgpt', entry.label);
        assert.equal(connection.route.provider, entry.api ? 'fixture' : 'openai', entry.label);
        await gui.click('#start');
        run = await waitFor(async () => {
          const { detection } = await gui.state();
          return detection?.id !== prior && detection?.status !== 'running' && detection;
        }, entry.label + ' sampled');
        assert.equal(run.samples.filter((sample) => sample.status === 'received').length, 3, entry.label);
        assert.equal(run.diagnostics.filter(({ status }) => status === 'error').length, failures.length);
      } else {
        assert.equal(await gui.evaluate('document.querySelector("#start").disabled'), true);
        assert.equal(await gui.evaluate('fingerprint.start("codex", "fixture-model")'), false);
      }
      const trace = (await readTrace()).filter((event) => event.test === entry.label);
      const calls = trace.filter((event) => event.method === 'exec');
      assert.equal(calls.length, entry.ready ? 3 : 0, entry.label);
      for (const call of calls) {
        assert.equal(call.endpoint, entry.api ? 'http://127.0.0.1:12345/v1' : 'https://chatgpt.com/backend-api/codex', entry.label);
        assert.equal(call.provider, entry.api ? 'fixture' : 'openai', entry.label);
        assert.equal(call.store, 'file');
        assert(call.ephemeral && call.isolated);
      }
      results.push({ label: entry.label, state: connection.state, account: connection.account, route: connection.route,
        message: connection.message, diagnostics: connection.diagnostics, trace,
        samples: run?.samples.map(({ count, expected, status }) => ({ count, expected, status })) });
    }
    for (const label of ['account-replaced', 'binary-replaced']) {
      await writeFile(control, 'chatgpt-healthy');
      await gui.click('#refresh');
      assert.equal((await gui.settled()).connection.state, 'ready');
      await writeFile(control, label);
      if (label === 'binary-replaced') {
        const changed = new Date(Date.now() + 5_000);
        await utimes(fixtureExe, changed, changed);
      }
      const prior = (await gui.state()).detection?.id;
      await gui.click('#start');
      const run = await waitFor(async () => {
        const { detection } = await gui.state();
        return detection?.id !== prior && detection?.status !== 'running' && detection;
      }, label + ' refused');
      assert.equal(run.status, 'failed', label);
      assert.match(run.message, /已变化/);
      const trace = (await readTrace()).filter((event) => event.test === label);
      assert(trace.length && !trace.some(({ method }) => method === 'exec'));
      results.push({ label, state: run.status, message: run.message, diagnostics: run.diagnostics, trace });
    }
  });
  await writeFile(join(evidence, 'codex-account-probes-packaged.json'), JSON.stringify({ mode: 'offline synthetic CLI', cases: results }, null, 2) + '\n');
  report.checks.push({ label: '独立 Codex RPC 探针和采样绑定夹具', cases: results.length });
}

try {
  await desktop(async (gui) => {
    const assertDamaged = async (label, state) => {
      assert.equal(state.source, 'codex');
      assert.equal(state.connection.state, 'error');
      assert.equal(state.connection.executablePath, null);
      assert.equal(state.connection.models.length, 0);
      assert.equal(await gui.evaluate('document.querySelector("#start").disabled'), true);
      assert.equal(await gui.evaluate('fingerprint.start("codex", "gpt-6.2-sol")'), false);
      assert.equal(await readFile(configFile, 'utf8'), '{invalid-json');
      await assert.rejects(access(join(localData, 'OpenSosen Model Fingerprint', 'sqlite')), { code: 'ENOENT' });
      assert.equal(report.requests.length, 0);
      report.checks.push({ label, message: state.connection.message });
    };
    await assertDamaged('打开损坏路径设置', await gui.settled());
    await gui.click('#refresh');
    await assertDamaged('点击刷新连接', await gui.settled());
    await assertDamaged('取消原生文件选择', await gui.picker());
    await mkdir(configFile + '.tmp');
    await assertDamaged('手选后保存失败', await gui.picker(selected));
    await rmdir(configFile + '.tmp');
    for (const source of ['claude-desktop', 'dsh-desktop']) {
      await gui.input('#source', source);
      const state = await gui.settled();
      assert.equal(state.source, source);
      assert.equal(state.connection.state, 'ready');
      await gui.input('#manual-model', 'fixture-model');
      await gui.click('#start');
      const { detection: run } = await waitFor(async () => {
        const current = await gui.state();
        return current.detection?.status === 'running' && current;
      }, 'manual challenges');
      assert.equal(run.mode, 'manual');
      assert.equal(run.route, null);
      await gui.click('#manual-replies details:first-child button');
      await waitFor(() => gui.evaluate('document.querySelector("#manual-replies details:first-child button").textContent === "已复制"'), 'clipboard confirmation');
      const text = fixtureReply(run.samples[0].expected) + '\n';
      await gui.input('#manual-reply-1', text);
      await gui.click('#manual-replies details:first-child .manual-actions button');
      await waitFor(() => gui.evaluate('document.querySelector("#manual-replies details:first-child [role=status]").textContent === "回复已保存"'), 'paste saved');
      await gui.click(source === 'claude-desktop' ? '#score-replies' : '#cancel');
      const finished = await waitFor(async () => {
        const { detection } = await gui.state();
        return detection.status !== 'running' && detection;
      }, 'manual finish/cancel');
      assert.equal(finished.samples[0].raw, text);
      assert.equal(finished.samples[0].count, finished.samples[0].expected);
      assert.equal(finished.samples[1].status, source === 'claude-desktop' ? 'skipped' : 'cancelled');
      if (source === 'dsh-desktop') assert.equal(finished.status, 'cancelled');
      await exportRun(gui, finished, 'fixture-' + source);
      await gui.screenshot('fixture-' + source);
      report.checks.push({ label: source, mode: finished.mode, status: finished.status, route: finished.route });
    }
    await gui.input('#source', 'codex');
    await assertDamaged('切换其他来源后返回 Codex', await gui.settled());
    await gui.screenshot('codex-damaged-after-refresh-and-switch');
    await gui.click('#use-path-codex');
    const recovered = await gui.settled();
    assert.equal(recovered.connection.state, 'ready');
    assert.deepEqual(JSON.parse(await readFile(configFile, 'utf8')), { executable: null });
    report.checks.push({ label: '显式恢复 PATH', version: recovered.connection.version });
  });
  await desktop(async (gui) => {
    const restarted = await gui.settled();
    assert.equal(restarted.connection.state, 'ready');
    assert.equal(restarted.connection.configuredExecutablePath, null);
    report.checks.push({ label: '恢复 PATH 后重启', version: restarted.connection.version });
    await writeFile(configFile, '{invalid-json');
  });
  await desktop(async (gui) => {
    assert.equal((await gui.settled()).connection.state, 'error');
    const chosen = await gui.picker(selected);
    assert.equal(chosen.connection.state, 'ready');
    assert.equal(chosen.connection.configuredExecutablePath, selected);
    report.checks.push({ label: '显式手选有效 Codex', version: chosen.connection.version });
    await gui.click('#start');
    const run = await waitFor(async () => {
      const { detection } = await gui.state();
      return detection && detection.status !== 'running' && detection;
    }, 'three Codex loopback samples', 100_000);
    assert.equal(run.source, 'codex');
    assert.equal(run.route.origin, route);
    assert.equal(run.samples.length, 3);
    assert.equal(new Set(run.samples.map((sample) => sample.threadId)).size, 3);
    assert(run.samples.every((sample) => sample.status === 'received' && sample.count === sample.expected));
    assert.equal(report.requests.length, 3);
    assert(report.requests.every((sample) => sample.fixtureKey && sample.users === 1 && sample.tools === 0 &&
      run.samples.some(({ prompt }) => digest(prompt) === sample.promptSha256)));
    await exportRun(gui, run, 'fixture-codex');
    await gui.screenshot('codex-loopback-three-samples');
    hold = true;
    await gui.click('#start');
    await waitFor(() => report.requests.some((sample) => sample.held), 'live local sampling before cancel', 40_000);
    await gui.click('#cancel');
    const cancelled = await waitFor(async () => {
      const { detection } = await gui.state();
      return detection.status === 'cancelled' && detection;
    }, 'automatic cancel');
    assert.equal(cancelled.analysis, null);
    await waitFor(() => report.requests.filter(({ held }) => held).every(({ closed }) => closed), 'cancelled local connections');
    report.checks.push({ label: '采样中取消', samples: cancelled.samples.map(({ status }) => status) });
  });
  await desktop(async (gui) => {
    const restarted = await gui.settled();
    assert.equal(restarted.connection.state, 'ready');
    assert.equal(restarted.connection.configuredExecutablePath, selected);
    report.checks.push({ label: '手选有效路径后重启', version: restarted.connection.version });
  });
  await accountProbeCases();
  report.passed = true;
  console.log('Packaged Windows regression passed with', report.checks.length, 'recorded checks.');
} catch (error) {
  report.error = error.stack;
  throw error;
} finally {
  gateway.closeAllConnections();
  await new Promise((done) => gateway.close(done));
  await writeFile(evidencePath, JSON.stringify(report, null, 2) + '\n');
}
