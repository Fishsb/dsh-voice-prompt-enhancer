'use strict';

// 目标模式：语音纠错执行域普通模块的语义锁 + 产物接线锁。
// 线上 voice/correct 契约不变：跳过仍带 skipped/skippedBy/switchFrom/code，且不伪造 changed。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT } = require('../scripts/lib/chunk-decode.mjs');
const {
  CORRECTION_WINDOW,
  resolveCorrectionWindow,
  CORRECTION_TIMEOUT_MS,
  CORRECTION_MAX_TOKENS,
  CORRECTION_OUTPUT_LIMIT,
  createCorrectionRunner,
} = require('../src/host/domains/voice/correction.cjs');

const MODULE_REL = 'src/host/domains/voice/correction.cjs';

function makeDeps(overrides) {
  const calls = [];
  const logs = [];
  const deps = {
    ctx: {
      get: () => undefined,
      timer: { timeout: () => () => {} },
    },
    harness: { readVoiceConfig: () => ({ correction: { enabled: true } }) },
    llm: {
      stream: () => {
        throw new Error('llm.stream must be overridden per test');
      },
    },
    hlog: (...args) => logs.push(args.join(' ')),
    startWaitAbort: () => ({ timedOut: () => false, race: (p) => p, dispose: () => {} }),
    validateConfig: (cfg) => cfg || { fallback: [{ provider: 'p', model: 'm' }] },
    buildTryChain: (fallback) => (Array.isArray(fallback) ? fallback : []),
    collectStream: async () => ({ kind: 'ok', text: '改写后的文本' }),
    cleanCorrectionOutput: (text) => text,
    friendlyMessage: ({ code }) => 'msg:' + code,
    extractHistoryConclusions: () => [],
    splitHistoryRounds: () => [],
    correctionPrompt: 'HISTORY={history}',
    historyTimeoutMs: 1000,
  };
  return { deps: Object.assign(deps, overrides || {}), calls, logs };
}

test('HCR-01 常量与既有纠错契约一致', () => {
  assert.deepEqual(CORRECTION_WINDOW, [1, 1]);
  assert.equal(CORRECTION_TIMEOUT_MS, 30000);
  assert.equal(CORRECTION_MAX_TOKENS, 4000);
  assert.equal(CORRECTION_OUTPUT_LIMIT, 16000);
});

test('HCR-02 开关关闭 ⇒ 零模型调用，返回既有跳过字段且不伪造 changed', async () => {
  const { deps } = makeDeps({
    harness: { readVoiceConfig: () => ({ correction: { enabled: false } }) },
    llm: { stream: () => { throw new Error('must not call'); } },
  });
  const runner = createCorrectionRunner(deps);
  const out = await runner.runCorrection({ sessionId: 's', text: '原文', config: {} });
  assert.equal(out.ok, true);
  assert.equal(out.skipped, true);
  assert.equal(out.skippedBy, 'correction.enabled');
  assert.equal(out.switchFrom, 'host-normalized');
  assert.equal(out.code, 'CORRECTION_DISABLED');
  assert.equal(out.text, '原文');
  assert.equal(Object.prototype.hasOwnProperty.call(out, 'changed'), false);
});

test('HCR-03 打开时走模型链；逐字回显 ⇒ changed=false，改写 ⇒ changed=true', async () => {
  let calls = 0;
  const { deps } = makeDeps({
    llm: {
      stream: () => {
        calls += 1;
        return {
          [Symbol.asyncIterator]() {
            let i = 0;
            return {
              async next() {
                if (i === 0) { i += 1; return { done: false, value: { type: 'text-delta', text: '改写后的文本' } }; }
                if (i === 1) { i += 1; return { done: false, value: { type: 'finish', reason: { kind: 'stop' } } }; }
                return { done: true };
              },
            };
          },
        };
      },
    },
  });
  const runner = createCorrectionRunner(deps);
  const out = await runner.runCorrection({ sessionId: 's', text: '原文', config: { fallback: [{ provider: 'p', model: 'm' }] } });
  assert.equal(calls, 1);
  assert.equal(out.ok, true);
  assert.equal(out.changed, true);
  assert.equal(out.text, '改写后的文本');
  assert.equal(out.fallbackUsed, false);
});

test('HCR-04 空文本 / 无模型 / 无模型链的既有错误码不变', async () => {
  const { deps: d1 } = makeDeps();
  const r1 = createCorrectionRunner(d1);
  assert.equal((await r1.runCorrection({ text: '   ' })).code, 'GUARD');
  const { deps: d2 } = makeDeps({ llm: undefined });
  assert.equal((await createCorrectionRunner(d2).runCorrection({ text: 'x' })).code, 'NO_LLM');
  const { deps: d3 } = makeDeps({ buildTryChain: () => [] });
  assert.equal((await createCorrectionRunner(d3).runCorrection({ text: 'x', config: {} })).code, 'NO_MODEL');
});

test('HCR-05 产物内联执行域模块（无外部 require），RPC 仍由 chunk 注册', () => {
  const host = fs.readFileSync(path.join(REPO_ROOT, 'plugin-host.js'), 'utf8');
  assert.ok(host.includes('"src/host/domains/voice/correction.cjs"'), 'host 产物必须内联纠错执行域模块');
  assert.ok(host.includes('"src/host/domains/voice/correction.cjs"'));
  assert.ok(host.includes('voice/correct'), 'voice/correct RPC 必须仍在位');
  assert.ok(host.includes('return correctionRunner.runCorrection(args);'), '既有 runCorrection 包装必须委托模块');
  assert.equal((host.match(/require\(/g) || []).length, 0, 'host 产物不得含外部 require');
});

// ─────────── O4（2026-11-08 · 语音四件收口批）：纠错参考窗口可配 ───────────
// 判据（用户拍板）：默认/非法一律回落 [1,1]；windowRounds=N（1–3）⇒ [1,N]。
//   ⚠ 只改「读多少轮」，⛔ 不改 UD-0051「必须有会话参考」这条。
test('HCR-06 ⭐resolveCorrectionWindow：默认/非法回落 [1,1]，1–3 取 [1,N]', () => {
  assert.deepEqual(resolveCorrectionWindow(undefined), [1, 1]);
  assert.deepEqual(resolveCorrectionWindow({}), [1, 1]);
  assert.deepEqual(resolveCorrectionWindow({ correction: {} }), [1, 1]);
  assert.deepEqual(resolveCorrectionWindow({ correction: { windowRounds: null } }), [1, 1]);
  assert.deepEqual(resolveCorrectionWindow({ correction: { windowRounds: 0 } }), [1, 1]);
  assert.deepEqual(resolveCorrectionWindow({ correction: { windowRounds: 9 } }), [1, 1]);
  assert.deepEqual(resolveCorrectionWindow({ correction: { windowRounds: '3' } }), [1, 1]);
  assert.deepEqual(resolveCorrectionWindow({ correction: { windowRounds: 1 } }), [1, 1]);
  assert.deepEqual(resolveCorrectionWindow({ correction: { windowRounds: 2 } }), [1, 2]);
  assert.deepEqual(resolveCorrectionWindow({ correction: { windowRounds: 3 } }), [1, 3]);
  // 旧常量本身**不得被改**（HCR-01 的断言仍逐字成立）
  assert.deepEqual(CORRECTION_WINDOW, [1, 1]);
});

test('HCR-07 ⭐fetchCorrectionHistory 用配置窗口读轮次，日志打实际窗口', async () => {
  const seen = [];
  const { deps, logs } = makeDeps({
    ctx: {
      get: () => ({ readSurface: () => Promise.resolve({ events: [{ role: 'user', text: 'a' }] }) }),
      timer: { timeout: () => () => {} },
    },
    extractHistoryConclusions: () => ['结论'],
    splitHistoryRounds: (events, first, last) => { seen.push([first, last]); return ['line']; },
  });
  const runner = createCorrectionRunner(deps);
  assert.equal(await runner.fetchCorrectionHistory('s', { correction: { windowRounds: 3 } }), 'line');
  assert.deepEqual(seen.at(-1), [1, 3], 'windowRounds=3 ⇒ 传 [1,3]');
  assert.ok(logs.some((l) => l.includes('history rounds=1-3')), '日志须打实际窗口；实得 ' + JSON.stringify(logs));

  await runner.fetchCorrectionHistory('s', {});
  assert.deepEqual(seen.at(-1), [1, 1], '缺省 ⇒ [1,1]');
  await runner.fetchCorrectionHistory('s');
  assert.deepEqual(seen.at(-1), [1, 1], '无 config ⇒ [1,1]');
  await runner.fetchCorrectionHistory('s', { correction: { windowRounds: 9 } });
  assert.deepEqual(seen.at(-1), [1, 1], '非法 ⇒ [1,1]');
});

test('HCR-08 ⭐runCorrection 把 args.config 传给历史读取（接线不丢参）', async () => {
  const seen = [];
  const { deps } = makeDeps({
    ctx: {
      get: () => ({ readSurface: () => Promise.resolve({ events: [] }) }),
      timer: { timeout: () => () => {} },
    },
    splitHistoryRounds: (events, first, last) => { seen.push([first, last]); return []; },
    llm: {
      stream: () => ({
        [Symbol.asyncIterator]() {
          let i = 0;
          return { async next() { return { done: true }; } };
        },
      }),
    },
  });
  const runner = createCorrectionRunner(deps);
  await runner.runCorrection({ sessionId: 's', text: '原文', config: { correction: { enabled: true, windowRounds: 2 }, fallback: [{ provider: 'p', model: 'm' }] } });
  assert.deepEqual(seen.at(-1), [1, 2], 'runCorrection 须把 config 一路传到 splitHistoryRounds');
});
// ─────────── CHG-390（2026-11-13 · 词库改作纠错参考）：{dictionary} 注入 ───────────
// 判据（用户 2026-11-13 拍板）：
//   ① 只把**草稿里命中的**词条喂进提示词（不是全量词库）；
//   ② 词库**不做字面替换** —— 发给模型的 text 恒等于草稿原文；
//   ③ 无命中 / 无词库 ⇒ {dictionary} 渲染为空串，提示词其余部分逐字不变。
test('HCR-09 ⭐词库命中注入 {dictionary}，且不改动发给模型的原文', async () => {
  const seen = [];
  const { deps } = makeDeps({
    harness: {
      readVoiceConfig: () => ({
        correction: { enabled: true },
        dictionary: { entries: [
          { from: '绘画', to: '会话', hits: 0, at: 1, enabled: true },
          { from: '未命中词', to: 'x', hits: 0, at: 1, enabled: true },
        ] },
      }),
    },
    correctionPrompt: 'DICT=[{dictionary}]\nHIST=[{history}]',
    llm: {
      stream: (req) => {
        seen.push({ system: req.system, text: req.messages[0].content[0].text });
        return { [Symbol.asyncIterator]() { return { async next() { return { done: true }; } }; } };
      },
    },
    collectStream: async () => ({ kind: 'ok', text: '这个会话很重要' }),
  });
  const runner = createCorrectionRunner(deps);
  const out = await runner.runCorrection({ sessionId: 's', text: '这个绘画很重要', config: { fallback: [{ provider: 'p', model: 'm' }] } });
  assert.equal(seen.length, 1);
  assert.ok(seen[0].system.includes('- 绘画 → 会话'), '命中条目须进提示词；实得 ' + seen[0].system);
  assert.ok(!seen[0].system.includes('未命中词'), '未命中的条目不进提示词');
  assert.equal(seen[0].text, '这个绘画很重要', '⛔ 词库不得预替换原文（text 逐字不变）');
  assert.deepEqual(out.dictionaryHits, [{ from: '绘画', to: '会话' }], '回传命中条目供 client 计数');
});

test('HCR-10 无命中 / 无词库 / 读取抛错 ⇒ {dictionary} 为空串且不阻断纠错', async () => {
  const systems = [];
  const makeLlm = () => ({
    stream: (req) => {
      systems.push(req.system);
      return { [Symbol.asyncIterator]() { return { async next() { return { done: true }; } }; } };
    },
  });
  const base = { correctionPrompt: 'D=[{dictionary}]', llm: makeLlm() };

  const noHit = makeDeps(Object.assign({}, base, {
    harness: { readVoiceConfig: () => ({ correction: { enabled: true }, dictionary: { entries: [{ from: '不出现', to: 'x', enabled: true }] } }) },
  }));
  const o1 = await createCorrectionRunner(noHit.deps).runCorrection({ sessionId: 's', text: '原文', config: { fallback: [{ provider: 'p', model: 'm' }] } });
  assert.equal(systems.at(-1), 'D=[]', '无命中 ⇒ 空串');
  assert.equal(Object.prototype.hasOwnProperty.call(o1, 'dictionaryHits'), false, '无命中不新增字段');

  const noDict = makeDeps(Object.assign({}, base, { harness: { readVoiceConfig: () => ({ correction: { enabled: true } }) } }));
  await createCorrectionRunner(noDict.deps).runCorrection({ sessionId: 's', text: '原文', config: { fallback: [{ provider: 'p', model: 'm' }] } });
  assert.equal(systems.at(-1), 'D=[]', '无 dictionary 段 ⇒ 空串');

  const noFace = makeDeps(Object.assign({}, base, { harness: { readVoiceConfig: () => { throw new Error('boom'); } } }));
  const o3 = await createCorrectionRunner(noFace.deps).runCorrection({ sessionId: 's', text: '原文', config: { fallback: [{ provider: 'p', model: 'm' }] } });
  assert.equal(o3.ok, true, '词库读取抛错不得阻断纠错（fail-closed 到"无参考"）');
  assert.equal(systems.at(-1), 'D=[]');
});
