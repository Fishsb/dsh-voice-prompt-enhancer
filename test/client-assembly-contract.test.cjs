'use strict';

// ============================================================================
// 装配契约（issue #16 批 · 2026-11-21）：把「依赖真的存在」变成可执行判据
// ============================================================================
// 病历：CHG-346 重构后，app.cjs 从 shared 取 prettifyModel（工厂产物成员，shared 不导出）
//   ⇒ createEnhanceButton 拿到 undefined ⇒ 仅「备用模型完成」结果态渲染时抛
//   TypeError: prettifyModel is not a function（v3.5.0 / v3.5.1 / HEAD 实测）。
//   旧套件 1042 条全绿：夹具自己注入了可用的 prettifyModel，装配面从未被校验。
//
// 本文件三层判据（缺一层就是假绿）：
//   CAC-1 静态：src/client/** 的每个 shared.<name> 必须命中 runtime.cjs 导出键
//   CAC-2 动态：真实 createClientApp 装配下，任何工厂 deps 值不得为 undefined
//   CAC-3 回归：真实装配 + fallbackUsed=true 结果态渲染不得抛（issue #16 本体）
// 并各带负控（变异自证：判据不是"写了就算"）。
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CLIENT_DIR = path.join(ROOT, 'src', 'client');
const { codeOnly } = require('../scripts/lib/code-only.mjs');

// ───────────────────────── CAC-1 静态：shared.* 必须可解析 ─────────────────────────

function collectClientSources(dir) {
  const out = new Map();
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      for (const [k, v] of collectClientSources(full)) out.set(k, v);
    } else if (entry.name.endsWith('.cjs')) {
      out.set(path.relative(ROOT, full), codeOnly(fs.readFileSync(full, 'utf8')));
    }
  }
  return out;
}

/** 纯函数：找出引用了、但导出面没有的名字。便于变异自证（喂假源码即可）。 */
function missingSharedRefs(sources, exportKeys) {
  const refs = new Map();
  for (const [file, code] of sources) {
    const re = /\bshared\.([A-Za-z_$][\w$]*)/g;
    let m;
    while ((m = re.exec(code))) {
      if (!refs.has(m[1])) refs.set(m[1], []);
      if (!refs.get(m[1]).includes(file)) refs.get(m[1]).push(file);
    }
  }
  const missing = [];
  for (const [name, files] of refs) {
    if (!exportKeys.has(name)) missing.push({ name, files: files.sort() });
  }
  return missing.sort((a, b) => a.name.localeCompare(b.name));
}

test('CAC-1 静态：src/client 的 shared.<name> 必须全部命中 runtime.cjs 导出键', () => {
  const runtime = require(path.join(CLIENT_DIR, 'common', 'runtime.cjs'));
  const sources = collectClientSources(CLIENT_DIR);
  assert.ok(sources.size > 20, '扫描面必须覆盖 src/client（实得 ' + sources.size + ' 个模块）');
  const missing = missingSharedRefs(sources, new Set(Object.keys(runtime)));
  assert.deepEqual(missing, [],
    'shared.<name> 引用了 runtime.cjs 未导出的名字（装配期会拿到 undefined）：' + JSON.stringify(missing));
});

test('CAC-1 负控：注入一个未导出名 ⇒ 同一判据必红（判别力自证）', () => {
  const runtime = require(path.join(CLIENT_DIR, 'common', 'runtime.cjs'));
  const poisoned = new Map([
    ['src/client/__poison__.cjs', 'const x = shared.__not_exported_anywhere__;\n'],
    ['src/client/__ok__.cjs', 'const y = shared.CSS;\n'],
  ]);
  const missing = missingSharedRefs(poisoned, new Set(Object.keys(runtime)));
  assert.deepEqual(missing.map((m) => m.name), ['__not_exported_anywhere__'],
    '负控失败：判据对注入的未导出名没有反应（假绿）');
  assert.deepEqual(missing[0].files, ['src/client/__poison__.cjs']);
  // 正控：真实导出名不得被误报
  assert.equal(missing.some((m) => m.name === 'CSS'), false);
});

// ───────────────────────── CAC-2 动态：装配 deps 不得为 undefined ─────────────────────────

const FACTORY_MODULE_RELS = [
  'common/state.cjs',
  'common/helpers.cjs',
  'domains/voice/index.cjs',
  'ui/navigation.cjs',
  'domains/settings/model-settings.cjs',
  'domains/settings/model-config-tab.cjs',
  'domains/settings/params-tab.cjs',
  'domains/settings/shell.cjs',
  'domains/enhance/components.cjs',
];

/** 纯函数：从装配记录里取「值真的是 undefined」的依赖。便于变异自证。 */
function undefinedDeps(records) {
  return records
    .filter((r) => r.undefinedDeps.length > 0)
    .map((r) => ({ factory: r.factory, undefinedDeps: r.undefinedDeps.slice().sort() }));
}

/** 在 app.cjs 加载前包装每个 create* 工厂，记录其 deps 里值为 undefined 的键。 */
function instrumentFactories() {
  const records = [];
  const wrap = (fn, name) => (deps) => {
    const undef = Object.entries(deps || {})
      .filter(([, v]) => v === undefined)
      .map(([k]) => k);
    records.push({ factory: name, undefinedDeps: undef });
    return fn(deps);
  };
  for (const rel of FACTORY_MODULE_RELS) {
    const abs = path.join(CLIENT_DIR, rel);
    const mod = require(abs);
    for (const [k, v] of Object.entries(mod)) {
      if (typeof v === 'function' && k.startsWith('create')) mod[k] = wrap(v, k);
    }
  }
  return records;
}

function makeAssemblyStubs() {
  const noop = () => {};
  const React = {
    createElement: () => null,
    Fragment: 'Fragment',
    useState: (v) => [v, noop],
    useEffect: noop,
    useMemo: (f) => f(),
    useRef: (v) => ({ current: v }),
    useCallback: (f) => f,
  };
  const documentStub = {
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ dataset: {}, style: {}, setAttribute: noop, appendChild: noop }),
    head: { appendChild: noop },
    body: { appendChild: noop },
    addEventListener: noop,
    removeEventListener: noop,
  };
  return {
    React,
    host: { call: () => Promise.resolve({ ok: false }), on: noop },
    styles: { insert: noop },
    window: { addEventListener: noop, removeEventListener: noop },
    document: documentStub,
    navigator: { mediaDevices: {} },
    MutationObserver: function () { this.observe = noop; this.disconnect = noop; },
    storage: null,
    localStorage: null,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    console: { log: noop },
  };
}

test('CAC-2 动态：真实 createClientApp 装配不得把 undefined 传给任何工厂', () => {
  const records = instrumentFactories();
  const { createClientApp } = require(path.join(CLIENT_DIR, 'app.cjs'));
  const stubs = makeAssemblyStubs();
  const app = createClientApp(stubs);
  assert.ok(app && typeof app.apply === 'function');

  const bad = undefinedDeps(records);
  assert.ok(records.length >= 10, '装配记录面必须覆盖工厂链（实得 ' + records.length + ' 次工厂调用）');
  assert.deepEqual(bad, [],
    '装配期把 undefined 当成依赖传给了工厂（渲染期必炸，且只在特定分支触发）：' + JSON.stringify(bad));
});

test('CAC-2 负控：手工塞一个 undefined 依赖 ⇒ 同一判据必红（判别力自证）', () => {
  const records = [];
  const fake = (deps) => deps;
  const wrapped = (name) => (deps) => {
    records.push({ factory: name, undefinedDeps: Object.entries(deps || {}).filter(([, v]) => v === undefined).map(([k]) => k) });
    return fake(deps);
  };
  wrapped('createProbe')({ good: 1, missing: undefined });
  const bad = undefinedDeps(records);
  assert.deepEqual(bad, [{ factory: 'createProbe', undefinedDeps: ['missing'] }],
    '负控失败：判据对人为 undefined 依赖没有反应（假绿）');
});

// ───────────────────────── CAC-3 回归：fallback 结果态渲染不抛 ─────────────────────────

function createReactHarness() {
  const hooks = [];
  let index = 0;
  let dirty = false;
  let pendingEffects = [];
  const React = {
    Fragment: 'Fragment',
    createElement(type, props) {
      const children = Array.from(arguments).slice(2).flat(9)
        .filter((v) => v !== null && v !== undefined && v !== false);
      return {
        type,
        props: Object.assign({}, props || {}, children.length
          ? { children: children.length === 1 ? children[0] : children }
          : {}),
      };
    },
    useState(initial) {
      const i = index++;
      if (!(i in hooks)) hooks[i] = { value: typeof initial === 'function' ? initial() : initial };
      const slot = hooks[i];
      return [slot.value, (next) => {
        slot.value = typeof next === 'function' ? next(slot.value) : next;
        dirty = true;
      }];
    },
    useRef(initial) {
      const i = index++;
      if (!(i in hooks)) hooks[i] = { current: initial };
      return hooks[i];
    },
    useEffect(fn, deps) {
      const i = index++;
      const prev = hooks[i];
      const changed = !prev || !deps || !prev.deps || deps.length !== prev.deps.length
        || deps.some((v, j) => v !== prev.deps[j]);
      if (!changed) return;
      if (prev && typeof prev.cleanup === 'function') prev.cleanup();
      hooks[i] = { deps, cleanup: null };
      pendingEffects.push({ i, fn });
    },
    useCallback(fn) { return fn; },
  };
  function renderOnce(Component, props) {
    index = 0;
    dirty = false;
    pendingEffects = [];
    const tree = Component(props);
    for (const item of pendingEffects) {
      const cleanup = item.fn();
      if (hooks[item.i]) hooks[item.i].cleanup = typeof cleanup === 'function' ? cleanup : null;
    }
    return tree;
  }
  function render(Component, props) {
    let tree = renderOnce(Component, props);
    let guard = 0;
    while (dirty && guard < 8) {
      tree = renderOnce(Component, props);
      guard += 1;
    }
    return tree;
  }
  function unmount() {
    for (const hook of hooks) {
      if (hook && typeof hook.cleanup === 'function') hook.cleanup();
    }
  }
  return { React, render, unmount };
}

function makeStorage() {
  const map = new Map();
  return {
    map,
    getItem(key) { return map.has(key) ? map.get(key) : null; },
    setItem(key, value) { map.set(key, String(value)); },
    removeItem(key) { map.delete(key); },
  };
}

function makeTimer() {
  return {
    calls: [],
    timeout(fn, ms) { this.calls.push({ type: 'timeout', ms }); return () => {}; },
    interval(fn, ms) { this.calls.push({ type: 'interval', ms }); return () => {}; },
  };
}

function buildAppliedApp(payload) {
  const { createClientApp } = require(path.join(CLIENT_DIR, 'app.cjs'));
  const harness = createReactHarness();
  const host = {
    calls: [],
    call(method, args) {
      this.calls.push({ method, args });
      if (method === 'enhance') return Promise.resolve(payload);
      if (method === 'config/get') return Promise.resolve({ ok: true, config: null });
      return Promise.resolve({ ok: true });
    },
  };
  const styles = { inserted: [], insert(css) { this.inserted.push(css); } };
  const storage = makeStorage();
  const documentStub = {
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ dataset: {}, style: {}, setAttribute() {}, appendChild() {} }),
    head: { appendChild() {} },
    body: { appendChild() {} },
    addEventListener() {},
    removeEventListener() {},
  };
  const app = createClientApp({
    React: harness.React,
    host,
    styles,
    window: { addEventListener() {}, removeEventListener() {} },
    document: documentStub,
    navigator: { mediaDevices: {} },
    MutationObserver: class { observe() {} disconnect() {} },
    storage,
    localStorage: null,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    console: { log() {} },
  });
  const timer = makeTimer();
  const entries = [];
  const slots = {
    inject(name, fn) { entries.push({ name, entry: fn() }); },
    register(meta, component) { return { meta, component }; },
  };
  const disposers = [];
  app.apply({
    get(name) {
      if (name === 'slots') return slots;
      if (name === 'locale') return { register() { return () => {}; }, bind() { return (key) => key; } };
      if (name === 'timer') return timer;
      return undefined;
    },
    effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d); },
  });
  const entry = entries.find((e) => e.entry && e.entry.meta.id === 'prompt-enhance');
  assert.ok(entry, '真实装配必须注册 conversation.input.right:prompt-enhance');
  return { component: entry.entry.component, harness, host, disposers };
}

async function renderFallbackResult(payload) {
  const { component, harness, host, disposers } = buildAppliedApp(payload);
  const props = {
    sessionId: 'cac-' + (payload.fallbackUsed === true ? 'fallback' : 'primary'),
    inputActions: { setDraft() {}, submit() {} },
    input: { draft: '把这段话写得更专业', phase: '' },
  };
  try {
    const idle = harness.render(component, props);
    assert.equal(idle.type, 'button', '空闲态必须渲染按钮');
    assert.equal(typeof idle.props.onClick, 'function');
    idle.props.onClick();
    assert.ok(host.calls.some((c) => c.method === 'enhance'), '点击必须真的发起 enhance RPC');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const result = harness.render(component, props);
    return { result, host };
  } finally {
    harness.unmount();
    for (const d of disposers) { try { d(); } catch (e) { /* 清理失败不影响断言 */ } }
  }
}

function treeText(node) {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (typeof node !== 'object') return '';
  // 本 harness 的 createElement 把子节点折叠进 props.children（与 test/client-apply-regression 同形）
  const kids = node.children !== undefined ? node.children : (node.props && node.props.children);
  if (Array.isArray(kids)) return kids.map(treeText).join('');
  return treeText(kids);
}

test('CAC-3 回归（issue #16）：备用模型完成的结果态渲染不得抛，且与普通结果同形', async () => {
  const primary = await renderFallbackResult({ ok: true, text: '专业版。', model: 'deepseek-v4-pro' });
  const fallback = await renderFallbackResult({ ok: true, text: '专业版。', model: 'deepseek-flash', fallbackUsed: true });

  assert.doesNotThrow(() => treeText(primary.result), '普通结果态渲染不得抛');
  // 修复前此处抛 TypeError: prettifyModel is not a function（issue #16 原样）
  assert.doesNotThrow(() => treeText(fallback.result), '备用模型结果态渲染不得抛（issue #16）');

  const primaryText = treeText(primary.result);
  const fallbackText = treeText(fallback.result);
  assert.ok(primaryText.includes('撤销优化'), '结果态文案必须是 t("result")，实得：' + JSON.stringify(primaryText));
  assert.ok(fallbackText.includes('撤销优化'), '备用模型结果态文案必须同形，实得：' + JSON.stringify(fallbackText));
  assert.equal(fallbackText, primaryText,
    '备用模型结果不得在可见正文里插入模型名/额外文案（≤6 字用户约束）');
  assert.equal(/deepseek|flash/i.test(fallbackText), false, '结果态正文不得出现模型 id');
});
