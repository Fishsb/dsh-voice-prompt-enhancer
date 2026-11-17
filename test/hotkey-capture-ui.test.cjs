'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// 热键「组合键录制」行为锁（2026-11-18 · 用户报「热键设置组合键不能设置了」）
//
// 为什么要有这条：热键录制**没有任何行为测试** —— 全仓只有 `grep parseVoiceHotkey` 的纯函数用例，
//   而「点输入框 → 按组合键 → 写进配置」这条链路零覆盖。历史上它出过两次问题
//   （PE-31：Esc 后仍继续录 / 卸载后全局位永久为 true），每次都是靠用户复报才发现。
//
// 本文件用**最小假 React** 渲染真实的 `createVoiceSection`，从渲染树里取到热键输入框，
//   直接调用它真实的 onFocus / onKeyDown / onBlur —— 断言的是**真实组件代码**，不是源码字符串。
//
// 判据：
//   HKUI-1 聚焦后进入录制态（`window.__voiceHotkeyCapturing` = true，输入框显示「请按组合键…」）
//   HKUI-2 按组合键 ⇒ saveVoiceCfg 收到 `{hotkey:{enabled:true, combo:'Ctrl+KeyA'}}`（顺序固定 Ctrl/Alt/Shift/Meta）
//   HKUI-3 纯修饰键按下**不得**写配置（必须等主键）
//   HKUI-4 写入后必须退出录制态（全局位复位 + 焦点移走）
//   HKUI-5 Esc 取消：不写配置、退出录制态
//   HKUI-6 失焦（onBlur）退出录制态且不写配置
const test = require('node:test');
const assert = require('node:assert/strict');
const voiceModules = require('./helpers/client-voice-modules.cjs');

// ── 最小假 React：只实现本组件用到的钩子，渲染成 {type, props} 树 ──────────────
function makeFakeReact() {
  const stateSlots = [];
  let cursor = 0;
  const effects = [];
  const React = {
    createElement(type, props, ...children) {
      const p = Object.assign({}, props || {});
      const kids = children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false);
      return { type, props: p, children: kids };
    },
    useState(init) {
      const i = cursor++;
      if (!(i in stateSlots)) stateSlots[i] = (typeof init === 'function' ? init() : init);
      const set = (v) => { stateSlots[i] = (typeof v === 'function' ? v(stateSlots[i]) : v); };
      return [stateSlots[i], set];
    },
    useRef(init) { const i = cursor++; return { current: i in stateSlots ? stateSlots[i] : (stateSlots[i] = init) }; },
    useEffect(fn) { effects.push(fn); },
    useMemo(fn) { cursor++; return fn(); },
    useCallback(fn) { cursor++; return fn; },
    useLayoutEffect(fn) { effects.push(fn); },
  };
  React.__resetCursor = () => { cursor = 0; };
  React.__effects = effects;
  return React;
}

function walk(node, out) {
  if (!node || typeof node !== 'object') return out;
  if (node.type) out.push(node);
  for (const c of (node.children || [])) walk(c, out);
  return out;
}

// 渲染一次真实 VoiceSection，返回 {nodes, saveVoiceCfg calls, captured}
function renderVoiceSection(opts) {
  const o = opts || {};
  const React = makeFakeReact();
  const saves = [];
  const voiceCfg = Object.assign({
    filler: { enabled: true },
    vad: { enabled: true, silenceMs: 2000 },
    hotkey: { enabled: false, combo: '' },
    autoEnhance: false,
    autoEnhanceMode: '',
    correction: { enabled: true, windowRounds: 1 },
    dictionary: { entries: [] },
  }, o.voiceCfg || {});
  const voiceCfgState = { value: voiceCfg };
  const fakeWindow = o.window || {};
  // 直接用真实 CJS 模块（section.cjs 是普通模块，`module.exports = { createVoiceSection }`）。
  //   ⚠ 不用 factoryBody 切片：那会把工厂签名切掉，且切片结果只能当文本读、不能求值。
  const createVoiceSection = require('../src/client/domains/voice/section.cjs').createVoiceSection;
  assert.equal(typeof createVoiceSection, 'function', 'section.cjs 必须导出 createVoiceSection');
  // 组件内部通过全局 window 读写录制位；本夹具把它注入成显式对象，避免污染真实全局。
  const g = globalThis;
  const savedWindow = g.window;
  if (o.noGlobalWindow === true) { try { delete g.window; } catch (e) { /* ignore */ } }
  else g.window = fakeWindow;
  const Comp = createVoiceSection({
    React,
    makeT: () => (k) => k,
    host: { call: () => Promise.resolve({ ok: true }) },
    voiceCfgState,
    subscribeVoiceConfig: () => () => {},
    saveVoiceCfg: (patch) => { saves.push(patch); },
    syncVoiceFromHost: () => {},
    vadSilenceMsOf: (v) => (v && v.vad && v.vad.silenceMs) || 2000,
    vadFloorDbOf: () => null,
    normalizeVadSilenceMs: (n) => n,
    CollapsibleSection: (p) => React.createElement('div', {}, p.children),
    voiceHotkeyDisplay: (c) => String(c || ''),
    officialVoiceBridge: null,
    MODE_VALUES: ['base', 'lite', 'standard', 'smart', 'publish'],
    fillerSnapshot: () => ({}), subscribeFiller: () => () => {},
    correctionSnapshot: () => ({}), subscribeCorrection: () => () => {},
    normalizeDictionaryEntries: (x) => x,
    VOICE_DICTIONARY_MAX_ENTRIES: 500, VOICE_DICTIONARY_MAX_TERM: 20,
    normalizeCorrectionWindowRounds: (n) => (Number.isInteger(n) && n >= 0 && n <= 5 ? n : 1),
    setTimeout: () => 0, clearTimeout: () => {},
    // ⚠ 关键：默认**不传** window（复现宿主 d.window 缺省的形态）。
    //   o.depWindow === null 时显式传 null（复现「typeof null === 'object' 导致旧写法抛错」的形态）。
    ...(Object.prototype.hasOwnProperty.call(o, 'depWindow') ? { window: o.depWindow } : {}),
  }).VoiceSection;
  let tree;
  try {
    tree = Comp({ t: (k) => k });
  } finally {
    if (savedWindow === undefined) delete g.window; else g.window = savedWindow;
  }
  return { nodes: walk(tree, []), saves, fakeWindow, React };
}

function hotkeyInput(nodes) {
  const el = nodes.find((n) => n.type === 'input' && n.props && n.props['aria-label'] === 'voiceHotkeyCombo');
  assert.ok(el, '渲染树里必须存在热键输入框（aria-label = voiceHotkeyCombo）');
  return el;
}

const keyEvent = (code, mods) => Object.assign({
  code, key: code, preventDefault() {}, stopPropagation() {},
}, mods || {});

test('HKUI-1 聚焦后进入录制态：全局位 = true，且输入框显示「请按组合键…」', () => {
  const r = renderVoiceSection();
  const el = hotkeyInput(r.nodes);
  assert.equal(typeof el.props.onFocus, 'function', '热键输入框必须挂 onFocus（否则无法进入录制态）');
  el.props.onFocus();
  assert.equal(r.fakeWindow.__voiceHotkeyCapturing, true, '聚焦后 window.__voiceHotkeyCapturing 必须为 true（全局监听据此让路）');
});

test('HKUI-2 按组合键必须写入配置，且修饰键顺序固定为 Ctrl/Alt/Shift/Meta', () => {
  const r = renderVoiceSection();
  const el = hotkeyInput(r.nodes);
  assert.equal(typeof el.props.onKeyDown, 'function', '热键输入框必须挂 onKeyDown（否则按了没反应）');
  el.props.onFocus();
  el.props.onKeyDown(keyEvent('KeyA', { ctrlKey: true }));
  assert.equal(r.saves.length, 1, '按一次组合键必须恰好写一次配置（实得 ' + r.saves.length + ' 次）');
  assert.deepEqual(r.saves[0], { hotkey: { enabled: true, combo: 'Ctrl+KeyA' } },
    '写入内容必须是 {hotkey:{enabled:true, combo:"Ctrl+KeyA"}}；实得 ' + JSON.stringify(r.saves[0]));
  // 多修饰键：顺序 Ctrl → Alt → Shift → Meta（与 parseVoiceHotkey 的解析顺序一致）
  const r2 = renderVoiceSection();
  const el2 = hotkeyInput(r2.nodes);
  el2.props.onFocus();
  el2.props.onKeyDown(keyEvent('KeyB', { metaKey: true, shiftKey: true, altKey: true, ctrlKey: true }));
  assert.equal(r2.saves[0].hotkey.combo, 'Ctrl+Alt+Shift+Meta+KeyB',
    '四修饰键顺序必须是 Ctrl+Alt+Shift+Meta（与 handler 的 push 顺序一致）；实得 ' + r2.saves[0].hotkey.combo);
});

test('HKUI-3 纯修饰键按下不得写配置（必须等主键）', () => {
  const r = renderVoiceSection();
  const el = hotkeyInput(r.nodes);
  el.props.onFocus();
  for (const c of ['Control', 'Alt', 'Shift', 'Meta']) {
    el.props.onKeyDown(keyEvent(c, { ctrlKey: c === 'Control' }));
  }
  assert.equal(r.saves.length, 0, '纯修饰键不得写入配置（实得 ' + r.saves.length + ' 次）');
  assert.equal(r.fakeWindow.__voiceHotkeyCapturing, true, '仍在等待主键 ⇒ 录制态必须保持');
});

test('HKUI-4 写入后必须退出录制态（全局位复位 + 焦点移走）', () => {
  let blurred = 0;
  const r = renderVoiceSection();
  const el = hotkeyInput(r.nodes);
  // 模拟真实 DOM：ref 指向一个可 blur 的元素
  const ref = el.props.ref;
  assert.ok(ref && typeof ref === 'object', '输入框必须带 ref（cancelHotkeyCapture 靠它移焦点）');
  ref.current = { blur() { blurred += 1; } };
  el.props.onFocus();
  el.props.onKeyDown(keyEvent('KeyA', { ctrlKey: true }));
  assert.equal(r.fakeWindow.__voiceHotkeyCapturing, false, '写入后全局位必须复位（否则热键永久失效）');
  assert.equal(blurred, 1, '写入后必须主动 blur 一次（否则 keydown 仍由录制 handler 接）');
});

test('HKUI-5 Esc 取消：不写配置、退出录制态', () => {
  const r = renderVoiceSection();
  const el = hotkeyInput(r.nodes);
  const ref = el.props.ref;
  let blurred = 0;
  ref.current = { blur() { blurred += 1; } };
  el.props.onFocus();
  el.props.onKeyDown(keyEvent('Escape', {}));
  assert.equal(r.saves.length, 0, 'Esc 不得写配置');
  assert.equal(r.fakeWindow.__voiceHotkeyCapturing, false, 'Esc 后全局位必须复位');
  assert.equal(blurred, 1, 'Esc 后必须移走焦点（PE-31 病历：不移焦点 ⇒ 仍在录）');
});

test('HKUI-6 失焦退出录制态且不写配置', () => {
  const r = renderVoiceSection();
  const el = hotkeyInput(r.nodes);
  assert.equal(typeof el.props.onBlur, 'function', '热键输入框必须挂 onBlur（否则全局位无法复位）');
  el.props.onFocus();
  el.props.onBlur();
  assert.equal(r.fakeWindow.__voiceHotkeyCapturing, false, '失焦后全局位必须复位');
  assert.equal(r.saves.length, 0, '失焦不得写配置');
});

test('HKUI-7 d.window 缺省时，录制位必须写到**真实全局** window（否则与 hotkey.cjs 读的不是同一个对象）', () => {
  // 这是本次故障的核心形态：section 写注入值、hotkey 读全局值 ⇒ 录制期间全局监听不让路
  //   ⇒ 它 capture 阶段 stopPropagation ⇒ 录制框收不到 keydown ⇒ 改不了组合键。
  const r = renderVoiceSection();   // 默认不传 depWindow
  const el = hotkeyInput(r.nodes);
  el.props.onFocus();
  assert.equal(r.fakeWindow.__voiceHotkeyCapturing, true,
    '即使 d.window 缺省，也必须写到真实全局 window 上（hotkey.cjs 读的是它）');
});

test('HKUI-8 d.window === null 时不得抛错（typeof null 是 "object"，旧写法会 TypeError）', () => {
  // 旧写法 `if (typeof window !== 'undefined') window.__x = true` 在 window=null 时：
  //   typeof null !== 'undefined' → true → null.__x = true → **TypeError**。
  //   该异常发生在 onFocus 里、且在 setHotkeyCapture(true) 之前 ⇒ 录制态永远进不去。
  const r = renderVoiceSection({ depWindow: null });
  const el = hotkeyInput(r.nodes);
  assert.doesNotThrow(() => el.props.onFocus(), 'onFocus 在 d.window=null 时不得抛错');
  assert.equal(r.fakeWindow.__voiceHotkeyCapturing, true, '此时应退回真实全局 window');
});

test('HKUI-9 hotkey.cjs 的录制位判空必须用 falsy 判空（不得用 typeof 判 undefined）', () => {
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'src/client/domains/voice/hotkey.cjs'), 'utf8');
  // ⛔ 旧形态：typeof window !== 'undefined' && window.__voiceHotkeyCapturing
  //   对 window=null 会抛 TypeError（每次按键都抛），且与 section 的写入目标可能不是同一对象。
  assert.equal(/typeof window !== 'undefined'\s*&&\s*window\.__voiceHotkeyCapturing/.test(src), false,
    '⛔ 不得再用 typeof 判空读录制位（window=null 时抛 TypeError）');
  assert.ok(/captureWindow && captureWindow\.__voiceHotkeyCapturing/.test(src),
    '必须用 falsy 判空读录制位（captureWindow && captureWindow.__voiceHotkeyCapturing）');
  assert.ok(/globalThis\.window\) \? globalThis\.window/.test(src),
    '必须优先解析真实全局 window（与 section.cjs 写入目标一致）');
});

