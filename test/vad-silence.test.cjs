'use strict';
// vad-silence.test —— PROJECT §7.4 / 方案 §4.6.2.7「静音检测间隔可配置」
//
// 契约（逐条对照 §7.4 原文，不自行设计）：
//   · 可调项 = VAD_SILENCE_MS（静音判定时长）；**不是** VAD_POLL_MS（100ms 内部轮询，不暴露）
//   · 档位 = 1–5 秒整数共 5 档；默认 2 秒（= 现值 ⇒ 不改变现有行为）
//   · 校验 = 接受 1–5 整数，非法值回落 2
//   · 落点改造 = VAD_REQUIRED_QUIET 由固定常量派生 → 按配置值**动态计算**
//   · 适用范围 = 两条录音入口共用同一值
//   · 须保留 = 自适应底噪校准 + 触发门 heardSpeech；60s 上限不受本配置影响
//
// 手法：与 official-bridge 测试一致——解码 chunk、注入假全局求值；无真麦克风前置。
// ⚠ 计时精度**未实测**（最坏偏差 ~VAD_POLL_MS = 100ms 粒度，见 U12/B4）——本文件**不**断言精度。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
// ⚠ 契约面收口批（2026-10-17 · 第 ② 件）：本地 `decodeChunk` 副本已删除，改共享单一事实源
//   （`scripts/lib/chunk-decode.mjs`，fail-closed 且报错点名声）。取具名成员解构 ——
//   `require()` 一个 ESM 模块拿到的是命名空间对象，不可直接调用（实测）。
const { decodeChunk } = require('../scripts/lib/chunk-decode.mjs');
const voiceModules = require('./helpers/client-voice-modules.cjs');
const { i18nSource } = require('./helpers/client-i18n.cjs');
const { stylesBody } = require('./helpers/client-styles.cjs');
const { voiceStateChunkWithDefaults } = require('./helpers/voice-state-chunk.cjs');

// 求值 state.js：得到归一化 / 帧数派生（§7.4 的单一事实源）
function loadState() {
  const src = voiceStateChunkWithDefaults();
  const lsBacking = new Map();
  const localStorageStub = {
    getItem: (k) => (lsBacking.has(k) ? lsBacking.get(k) : null),
    setItem: (k, v) => lsBacking.set(k, String(v)),
    removeItem: (k) => lsBacking.delete(k),
  };
  const factory = new Function(
    'localStorage', 'host',
    src + '\n;return { normalizeVadSilenceMs, vadSilenceMsOf, vadRequiredQuiet, VOICE_CFG_DEFAULTS, voiceCfgState, mergeVoice, saveVoiceCfg, persistVoiceLocal };'
  );
  return factory(localStorageStub, { call: () => Promise.resolve({ ok: false }) });
}

// ───────────── ① 5 档各值被正确接受并落到 VAD_REQUIRED_QUIET ─────────────
test('VADSIL-P01 五档逐一接受：1–5 秒 → 1000/2000/3000/4000/5000ms', () => {
  const S = loadState();
  const expected = { 1: 1000, 2: 2000, 3: 3000, 4: 5000 - 1000, 5: 5000 };
  for (const [sec, ms] of Object.entries(expected)) {
    assert.equal(S.normalizeVadSilenceMs(Number(sec)), ms, sec + ' 秒应归一为 ' + ms + 'ms');
  }
});

test('VADSIL-P02 五档逐一落到 VAD_REQUIRED_QUIET（动态计算，非固定常量）', () => {
  const S = loadState();
  // §7.4：帧数 = 配置秒数 × 1000 / VAD_POLL_MS(100) ⇒ 1→10 / 2→20 / 3→30 / 4→40 / 5→50
  assert.equal(S.vadRequiredQuiet(1000), 10, '1 秒 → 10 帧');
  assert.equal(S.vadRequiredQuiet(2000), 20, '2 秒 → 20 帧（= 改前常量值）');
  assert.equal(S.vadRequiredQuiet(3000), 30, '3 秒 → 30 帧');
  assert.equal(S.vadRequiredQuiet(4000), 40, '4 秒 → 40 帧');
  assert.equal(S.vadRequiredQuiet(5000), 50, '5 秒 → 50 帧');
});

test('VADSIL-P03 动态性硬断言：帧数不是常量（5 档必须给出 5 个互不相同的值）', () => {
  const S = loadState();
  const frames = [1000, 2000, 3000, 4000, 5000].map((ms) => S.vadRequiredQuiet(ms));
  assert.equal(new Set(frames).size, 5, '5 档必须产生 5 个互不相同的帧数（若为常量则全等 ⇒ 判据红）');
  assert.deepEqual(frames, [10, 20, 30, 40, 50], '帧数须随配置单调变化');
});

// ───────────── ② 非法值一律回落 2 ─────────────
test('VADSIL-P04 非法值逐一回落 2000：0 / 6 / 1.5 / "x" / null', () => {
  const S = loadState();
  const bad = [0, 6, 1.5, 'x', null];
  for (const v of bad) {
    assert.equal(S.normalizeVadSilenceMs(v), 2000, '非法值 ' + JSON.stringify(v) + ' 必须回落 2000');
  }
});

test('VADSIL-P05 非法值扩展集同样回落：负数 / 空串 / 数组 / 对象 / NaN / undefined / 布尔', () => {
  const S = loadState();
  const bad = [-1, -2000, '', [], {}, NaN, undefined, true, false, '2000', 100000];
  for (const v of bad) {
    assert.equal(S.normalizeVadSilenceMs(v), 2000, '非法值 ' + JSON.stringify(v) + ' 必须回落 2000');
  }
});

test('VADSIL-P06 毫秒书写等价：1000–5000 的 1000 整数倍被接受（与秒整数同域）', () => {
  const S = loadState();
  assert.equal(S.normalizeVadSilenceMs(1000), 1000);
  assert.equal(S.normalizeVadSilenceMs(3000), 3000);
  assert.equal(S.normalizeVadSilenceMs(5000), 5000);
  // 非 1000 整数倍（即使落在区间内）不得被当成 ms 通过
  assert.equal(S.normalizeVadSilenceMs(2500), 2000, '2500 不在合法档位 ⇒ 回落');
});

// ───────────── ③ 默认 2 秒 ⇒ 行为与改前一致（双读数） ─────────────
test('VADSIL-P07 双读数·默认值：VOICE_CFG_DEFAULTS.vad.silenceMs === 2000（= 改前硬编码值）', () => {
  const S = loadState();
  assert.equal(S.VOICE_CFG_DEFAULTS.vad.silenceMs, 2000,
    '默认必须等于改前的 VAD_SILENCE_MS 硬编码值（否则等于改行为）');
  assert.equal(S.VOICE_CFG_DEFAULTS.vad.enabled, true, 'vad 默认开（既有行为不变）');
});

test('VADSIL-P08 双读数·未配置时帧数 = 改前常量值 20（行为不变的判定式）', () => {
  const S = loadState();
  // 改前：Math.round(2000 / 100) === 20；改后未配置 ⇒ 同一入口必须同样给 20
  assert.equal(Math.round(2000 / 100), 20, '（改前基线）固定常量派生的帧数');
  assert.equal(S.vadRequiredQuiet(undefined), 20, '（改后）未配置 ⇒ 同一读数');
  assert.equal(S.vadRequiredQuiet(S.vadSilenceMsOf({})), 20, '（改后）空配置 ⇒ 同一读数');
  assert.equal(S.vadRequiredQuiet(S.vadSilenceMsOf({ vad: {} })), 20, '（改后）无 silenceMs ⇒ 同一读数');
});

test('VADSIL-P09 mergeVoice 白名单：非法 silenceMs 被净化，合法值保留', () => {
  const S = loadState();
  assert.equal(S.mergeVoice({ vad: { silenceMs: 4000 } }).vad.silenceMs, 4000, '合法 4000 保留');
  assert.equal(S.mergeVoice({ vad: { silenceMs: 6 } }).vad.silenceMs, 2000, '非法 6 回落');
  assert.equal(S.mergeVoice({ vad: { silenceMs: 1.5 } }).vad.silenceMs, 2000, '非法 1.5 回落');
  assert.equal(S.mergeVoice({ vad: {} }).vad.silenceMs, 2000, '缺位回落默认');
  assert.equal(S.mergeVoice({}).vad.silenceMs, 2000, '空配置回落默认');
  // 既有字段不得被本改动影响
  assert.equal(S.mergeVoice({ vad: { enabled: false } }).vad.enabled, false, 'enabled:false 仍保留');
  assert.equal(S.mergeVoice({ vad: {} }).vad.enabled, true, 'enabled 默认仍 true');
});

// ───────────── ④ 两个开关与其余三项增值不回归 ─────────────
// CHG-117（2026-10-16 · 规整改造批）：原第 [4] 项 `refine` 已改名为 `filler`（只留 `enabled`，
//   默认 **开**）。本用例的**其余三项语义逐条未变**；改名处同步改名，**未删任何断言**。
test('VADSIL-P10 不回归：vad.enabled / autoEnhance / hotkey / filler 四项仍在且语义不变', () => {
  const S = loadState();
  const d = S.VOICE_CFG_DEFAULTS;
  assert.equal(d.vad.enabled, true, '[1] 静音监测默认开');
  assert.equal(d.autoEnhance, false, '[2] 自动增强默认关');
  assert.equal(d.hotkey.enabled, false, '[3] 热键默认关（combo 空）');
  assert.equal(d.filler.enabled, true, '[4] 清口水词默认开（用户裁定 4）');
  assert.equal(d.refine, undefined, 'CHG-117：旧父键 refine 不得回流');
  const m = S.mergeVoice({ autoEnhance: true, hotkey: { enabled: true, combo: 'Backquote' }, filler: { enabled: false } });
  assert.equal(m.autoEnhance, true, 'autoEnhance true 保留');
  assert.equal(m.hotkey.enabled, true, 'hotkey true 保留');
  assert.equal(m.hotkey.combo, 'Backquote', 'combo 保留');
  assert.equal(m.filler.enabled, false, 'filler false 保留');
  assert.equal(S.mergeVoice({ filler: { enabled: 'x' } }).filler.enabled, true, '非 false 一律视为开（与 host 同形）');
  assert.equal(S.mergeVoice({}).filler.enabled, true, '缺省 ⇒ 开');
  assert.equal(S.mergeVoice({ refine: { enabled: true } }).filler.enabled, true, '⚠ 旧键不得被读取（改名后无读旧名路径）');
});

test('VADSIL-P11 不回归：host 侧 sanitizeVoiceCfg 白名单与 client 同口径', () => {
  const asr = require(path.join(ROOT, 'lib', 'asr.cjs'));
  // 合法 5 档
  assert.equal(asr.sanitizeVoiceCfg({ vad: { silenceMs: 1000 } }).vad.silenceMs, 1000);
  assert.equal(asr.sanitizeVoiceCfg({ vad: { silenceMs: 3000 } }).vad.silenceMs, 3000);
  assert.equal(asr.sanitizeVoiceCfg({ vad: { silenceMs: 5000 } }).vad.silenceMs, 5000);
  // 非法集（§7.4 点名的 5 个）一律回落 2 秒
  for (const v of [0, 6, 1.5, 'x', null]) {
    assert.equal(asr.sanitizeVoiceCfg({ vad: { silenceMs: v } }).vad.silenceMs, 2000,
      'host 侧非法值 ' + JSON.stringify(v) + ' 必须回落 2000');
  }
  // 既有面不回归
  assert.equal(asr.sanitizeVoiceCfg({ vad: { enabled: false } }).vad.enabled, false, 'enabled 仍可关');
  assert.equal(asr.sanitizeVoiceCfg({}).vad.enabled, true, 'enabled 默认仍开');
  assert.equal(asr.sanitizeVoiceCfg({ autoEnhance: true }).autoEnhance, true, 'autoEnhance 不受影响');
});

// ───────────── 落点改造：两条入口共用同一入口 ─────────────
test('VADSIL-P12 共用同一入口：静音档位由 bridge 的包装 VAD 单一入口驱动（自建链已退役）', () => {
  const br = voiceModules.officialBridgeSource();
  // P2-补做（2026-10-13 · UD-0016）：自建采集链退役 ⇒ VAD 只剩**一条链路**（bridge 包装 VAD）。
  // 判据强度不变：仍逐项断言「按配置动态计算 + 取同一配置值 + 不得有固定帧数常量」。
  assert.equal(fs.existsSync(path.join(ROOT, 'src/client/voice/recorder.js')), false,
    'recorder.js 退役占位不得保留为源码 chunk');
  // 包装 VAD：同一入口（唯一在用的落点）
  assert.ok(br.includes('vadRequiredQuiet(vadSilenceMsOf(voiceCfgState.value))'), 'bridge 缺「经同一入口按配置动态计算帧数」');
  assert.equal(br.includes('const OVB_REQUIRED_QUIET'), false, 'bridge 不得再有固定帧数常量');
  assert.equal(/\bconst OVB_SILENCE_MS\b/.test(br.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')), false, 'bridge 活代码不得再有硬编码静音时长常量');
});

test('VADSIL-P13 须保留：自适应底噪校准与触发门 heardSpeech 在包装 VAD 中在位', () => {
  const br = voiceModules.officialBridgeSource();
  // P2-补做（UD-0016）：两条路径收敛为一条（wrapper VAD）⇒ 只判该条；记录退役事实的那一份不带活代码。
  for (const [name, src] of [['official-bridge', br]]) {
    assert.ok(src.includes('heardSpeech'), name + ' 缺触发门 heardSpeech（未说话不得触发，防误停）');
    assert.ok(/CALIBRATE_FRAMES/.test(src), name + ' 缺自适应底噪校准采样帧数');
    assert.ok(/NOISE_FACTOR/.test(src), name + ' 缺自适应阈值系数');
    assert.ok(/THRESHOLD_MAX/.test(src), name + ' 缺阈值上限');
    // 触发门语义：必须先 heardSpeech 才计静音帧
    assert.ok(/else if \(heardSpeech\)/.test(src), name + ' 触发门用法被改（须保持「先听到语音才计静音」）');
  }
});

// ───────── VADSIL-P14（2026-11-13 设置面板排版批 · 方案 H 订正）─────────
// ⚠ 订正依据（用户逐字，三句）：
//   ①「有下拉框的，开关集成在下拉框内，倾向面板元素集中一点的排版」
//   ②「开·跟随全局，这种只需要显示跟随全局就可以了，有档位就是开启状态不需要多余标一个开」
//   ③「环境噪声的样式和语音热键的样式完全对齐一致，就是输入框可以自定义输入，后面一个小符号代表测试」
//   ⇒ 原 P14 系列锁的是「首行三 chip + 第二行 开关/滑块/读数」那套结构（滑块已整体退役）。
//   本批**逐条按新结构订正**，锁的意图不变：静音监测的档位与开关只有一份真相（vad.enabled + silenceMs）。
// ⚠ 手法保持不降级：真实载入语音设置模块（factoryBody → 求值 → 渲染 → 展开函数组件），
//   不以子串断言代替、不以外部桩替代该文件；走的仍是真 mergeVoice（saveVoiceCfg 来自 state.js）。

/** 渲染语音设置模块的 VoiceSection，返回展开后的元素树（真载入，无桩替代）。 */
function renderVoiceSection(cfg) {
  const src = voiceModules.voiceSectionSource();
  const ReactStub = {
    createElement: (type, props, ...kids) => {
      const flat = kids.flat(9).filter((k) => k !== null && k !== undefined && k !== false);
      const pr = Object.assign({}, props || {});
      if (flat.length) pr.children = flat.length === 1 ? flat[0] : flat;
      return { type, props: pr, kids: flat };
    },
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useRef: (init) => ({ current: init }),
    useEffect: () => {},
  };
  const saved = [];
  const S = loadState();
  const voiceCfgState = S.voiceCfgState;
  voiceCfgState.value = Object.assign({}, S.VOICE_CFG_DEFAULTS, {
    autoEnhance: false, correction: { enabled: false }, filler: { enabled: false },
    hotkey: { enabled: false, combo: '' },
  }, cfg || {});
  const factory = new Function(
    'React', 'makeT', 'host', 'voiceCfgState', 'subscribeVoiceConfig', 'saveVoiceCfg', 'syncVoiceFromHost',
    'vadSilenceMsOf', 'normalizeVadSilenceMs', 'CollapsibleSection',
    'voiceHotkeyDisplay',
    'setTimeout', 'clearTimeout', 'window',
    src + ';return { VoiceSection };'
  );
  const api = factory(
    ReactStub, () => (k) => k, { call: () => Promise.resolve({ ok: false }) },
    voiceCfgState, () => () => {},
    (patch) => { saved.push(patch); S.saveVoiceCfg(patch); },
    () => {}, S.vadSilenceMsOf, S.normalizeVadSilenceMs,
    (p) => ReactStub.createElement('section', {}, p.children),
    (c) => String(c || ''),
    setTimeout, clearTimeout, {}
  );
  const expand = (n) => {
    if (!n || typeof n !== 'object') return n;
    if (typeof n.type === 'function') { const o = n.type(n.props); return o ? expand(o) : null; }
    return { type: n.type, props: n.props, kids: (n.kids || []).map(expand).filter(Boolean) };
  };
  return { tree: expand(api.VoiceSection({})), saved, S, voiceCfgState };
}

/**
 * 「设置项下拉」谓词（2026-11-13 · 方案 H）。
 *
 * 病历：本文件原先以语义谓词认「装 >=2 个 ToggleChip 的容器」和「装 type=range 滑块的容器」——
 *   那两条谓词绑定的都是**已被用户推翻的结构**（开关按钮 / 滑块）。方案 H 之后这两类元素一个都不存在
 *   ⇒ 谓词认不出行 ⇒ P14 系列集体红（不是行为坏了，是判据绑定了旧形态）。
 *   ⇒ 改成**按 aria-label 认下拉**：每个设置项的下拉都带 aria-label = 该项名称（可访问性要求，
 *     与视觉无关），因此它是**语义**而不是形态。⛔ 不用位置、不用 class 名认行。
 */
function selectByLabel(root, labelKey) {
  const want = String(labelKey);
  const walk = (n) => {
    if (!n || typeof n !== 'object') return null;
    if (n.type === 'select' && n.props && n.props['aria-label'] === want) return n;
    for (const k of (n.kids || [])) { const hit = walk(k); if (hit) return hit; }
    return null;
  };
  return walk(root);
}

/** 取静音监测下拉（按 aria-label 语义定位，⛔ 不按位置）。 */
function layoutRows(cfg) {
  const r = renderVoiceSection(cfg);
  const section = r.tree.kids[0];
  const vadSelect = selectByLabel(section, 'voiceVadShort');
  return { r, section, vadSelect };
}

test('VADSIL-P14 静音监测 = 一个「关 / 1-5 秒」合一下拉（不再是 开关+滑块+读数 三件）', () => {
  const { vadSelect, section } = layoutRows({ vad: { enabled: true, silenceMs: 3000 } });
  assert.ok(vadSelect, '静音监测下拉须在位（aria-label = voiceVadShort）');
  const opts = vadSelect.kids.filter((k) => k && k.type === 'option');
  assert.equal(opts.length, 6, '下拉须恰 6 个候选（关 + 1-5 秒）；实得 ' + opts.length);
  assert.equal(opts[0].props.value, 'off', '首项须是「关」（值 off = 停用）');
  assert.deepEqual(opts.slice(1).map((o) => o.props.value), ['1', '2', '3', '4', '5'], '其后须是 1-5 秒档位');
  assert.equal(/type: 'range'/.test(voiceModules.voiceSectionSource()), false, '源码不得再有 range 滑块');
  const sliders = (function walk(n, out) {
    out = out || [];
    if (!n || typeof n !== 'object') return out;
    if (n.props && n.props.type === 'range') out.push(n);
    (n.kids || []).forEach((k) => walk(k, out));
    return out;
  })(section);
  assert.equal(sliders.length, 0, '渲染树里不得再有滑块（档位已并入下拉）');
});

test('VADSIL-P14b 下拉的当前值 = 开关真相（单一事实源：vad.enabled + silenceMs）', () => {
  assert.equal(layoutRows({ vad: { enabled: true, silenceMs: 3000 } }).vadSelect.props.value, '3',
    '开 + 3 秒 => 下拉值须为 3');
  assert.equal(layoutRows({ vad: { enabled: false, silenceMs: 3000 } }).vadSelect.props.value, 'off',
    '关 => 下拉值须为 off');
  for (const sec of [1, 2, 3, 4, 5]) {
    assert.equal(layoutRows({ vad: { enabled: true, silenceMs: sec * 1000 } }).vadSelect.props.value, String(sec),
      sec + ' 秒档须映射为下拉值 ' + sec);
  }
  const S = loadState();
  assert.equal(S.normalizeVadSilenceMs(0), 2000, 'normalizeVadSilenceMs 的域不得改：0 仍非法 => 回落 2000');
  for (const n of [1, 2, 3, 4, 5]) assert.equal(S.normalizeVadSilenceMs(n), n * 1000, '档位 ' + n + ' 秒仍合法');
});

test('VADSIL-P14c 选「关」只置 enabled=false，同段其它字段一个都不丢（silenceMs/floorDb/floorMeasuredAt）', () => {
  const r = renderVoiceSection({ vad: { enabled: true, silenceMs: 5000, floorDb: -42.3, floorMeasuredAt: 1794552841922 } });
  const sel = selectByLabel(r.tree.kids[0], 'voiceVadShort');
  assert.ok(sel, '前置：静音监测下拉须在位');
  sel.props.onChange({ target: { value: 'off' } });
  assert.equal(r.S.voiceCfgState.value.vad.enabled, false, '选关须置 enabled = false');
  // 2026-11-13（用户裁定）：开关并入下拉后没有「关->开回到上次档位」这回事 ——
  //   要开启必须自己选档位，那一步就写入新档位。本条判据随之改为不丢其它字段（这才是真风险）：
  //   选关时若不带上 silenceMs/floorDb/floorMeasuredAt，patch.vad 整体替换会把它们归一为默认，静默丢值。
  assert.equal(r.S.voiceCfgState.value.vad.silenceMs, 5000, '选关不得改动 silenceMs（未选档位就不该被归一成默认 2000）');
  assert.equal(r.S.voiceCfgState.value.vad.floorDb, -42.3, '选关不得丢掉 floorDb（同段字段须原样带上）');
  assert.equal(r.S.voiceCfgState.value.vad.floorMeasuredAt, 1794552841922, '选关不得丢掉 floorMeasuredAt');
  assert.equal(r.S.voiceCfgState.value.vad.silenceMs === 0, false, 'silenceMs 不得被写成 0（那是另立第二份真相）');
  // 重新开启 = 用户自己选档位；选几就是几（没有恢复上次这回事）
  const r2 = renderVoiceSection({ vad: { enabled: false, silenceMs: 5000 } });
  const sel2 = selectByLabel(r2.tree.kids[0], 'voiceVadShort');
  sel2.props.onChange({ target: { value: '3' } });
  assert.equal(r2.S.voiceCfgState.value.vad.enabled, true, '选档位须置 enabled = true');
  assert.equal(r2.S.voiceCfgState.value.vad.silenceMs, 3000, '选 3 秒 => silenceMs 须为 3000（用户选的，不是恢复旧值）');
});
test('VADSIL-P14d 档位候选文案 = 「N 秒」，不带「开 ·」前缀（用户逐字②）', () => {
  const { vadSelect } = layoutRows({ vad: { enabled: true, silenceMs: 2000 } });
  const opts = vadSelect.kids.filter((k) => k && k.type === 'option');
  for (let i = 1; i < opts.length; i += 1) {
    const text = String(opts[i].props.children);
    assert.equal(new RegExp('^' + i + ' ').test(text), true,
      i + ' 秒档文案须以档位数字开头（实得 ' + JSON.stringify(text) + '）');
    assert.ok(text.includes('voiceVadSilenceUnit'), i + ' 秒档文案须带单位键');
    assert.equal(/voiceAutoEnhanceOn|voiceAutoEnhanceOff/.test(text), false,
      '档位文案不得拼开/关（有档位本身就是开启）');
  }
});

test('VADSIL-P14e voiceSilenceOff 仍有消费者（诊断区；位置纪律回归）', () => {
  const vs = voiceModules.voiceSectionSource();
  assert.ok(vs.includes("t('voiceSilenceOff')"),
    'voiceSilenceOff 须仍有消费者（OfficialVoiceDiag 的 vadEnabled===false 分支）');
  const iSilence = vs.indexOf("t('voiceSilenceOff')");
  const iArmed = vs.indexOf("t('voiceOfficialArmed')");
  assert.ok(iSilence > 0 && iArmed > iSilence,
    '位置纪律回归：开关关闭分支仍须排在正常分支（armed）之前');
});

test('VADSIL-P14f 四个设置项都是「关 + 档位」下拉，且首项同为 off（一致交互语言）', () => {
  const { section } = layoutRows({ vad: { enabled: true, silenceMs: 3000 } });
  const labels = ['voiceAutoEnhance', 'voiceCorrectionShort', 'voiceRefineShort', 'voiceVadShort'];
  for (const lab of labels) {
    const sel = selectByLabel(section, lab);
    assert.ok(sel, '缺设置项下拉：' + lab);
    const first = sel.kids.filter((k) => k && k.type === 'option')[0];
    assert.equal(first.props.value, 'off', lab + ' 的首项须是「关」（值 off）');
  }
});

test('VADSIL-P14g 不得退回固定像素宽（开关方块病历的成因判据保留）', () => {
  const vs = voiceModules.voiceSectionSource();
  const st = stylesBody();
  for (const needle of ["width: '96px'", "width: '112px'", "minWidth: '112px'"]) {
    assert.equal(vs.includes(needle), false, '源码不得出现固定宽 ' + needle);
  }
  const lb = st.match(/'[.]va-lb[{]([^}]*)[}]'/);
  assert.ok(lb, 'styles.js 须有 .va-lb 规则');
  assert.ok(/width:76px/.test(lb[1]), '标签列宽须是统一定值（各行对齐的成因）');
  const ct = st.match(/'[.]va-ct[{]([^}]*)[}]'/);
  assert.ok(ct, 'styles.js 须有 .va-ct 规则');
  assert.equal(/width:[0-9]+px/.test(ct[1]), false, '控件列不得写死像素宽');
});

test('VADSIL-P14h 行高不受网格拉伸影响（flex 容器 + 显式 align-items:center）', () => {
  const st = stylesBody();
  const row = st.match(/'[.]va-row[{]([^}]*)[}]'/);
  assert.ok(row, 'styles.js 须有 .va-row 规则');
  assert.equal(/display:grid/.test(row[1]), false, '行不得是 grid（grid 项默认 stretch => 会把控件沿块轴拉高）');
  assert.ok(/display:flex/.test(row[1]), '行须是 flex');
  assert.ok(/align-items:center/.test(row[1]), '必须 align-items:center —— 默认 stretch 会把控件拉成方块');
  const g = st.match(/'[.]va-grid2[{]([^}]*)[}]'/);
  assert.ok(g, 'styles.js 须有 .va-grid2 规则');
  assert.ok(/grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/.test(g[1]), '.va-grid2 须恒两栏（用户叫停单列切换）');
});

test('VADSIL-P14i 环境噪声 = 可编辑输入框 + 尾部图标按钮（与热键同构；用户逐字③）', () => {
  const { section } = layoutRows({ vad: { enabled: true, silenceMs: 3000 } });
  const noiseInput = (function walk(n) {
    if (!n || typeof n !== 'object') return null;
    if (n.type === 'input' && n.props && n.props['aria-label'] === 'voiceFloorLabel') return n;
    for (const k of (n.kids || [])) { const hit = walk(k); if (hit) return hit; }
    return null;
  })(section);
  assert.ok(noiseInput, '环境噪声输入框须在位（aria-label = voiceFloorLabel）');
  assert.notEqual(noiseInput.props.readOnly, true, '噪声输入框不得只读（用户要求可自定义输入）');
  assert.ok(noiseInput.props.onChange, '噪声输入框须有 onChange（可编辑）');
  assert.ok(noiseInput.props.onBlur, '噪声输入框须在 blur 提交（不每敲一字符就写配置）');
  const hasSuffix = (function walk(n) {
    if (!n || typeof n !== 'object') return false;
    if (n.props && typeof n.props.className === 'string' && /va-suffix/.test(n.props.className)) return true;
    return (n.kids || []).some(walk);
  })(section);
  assert.ok(hasSuffix, '单位 dBFS 须以内嵌后缀 .va-suffix 承载');
});

// ═════════ VADSIL-P14x 变异自证（三处各自退回 => 相应判据必红）═════════════
// ⚠ 手法：内存变异（把真源码文本改一处后求值）——不落盘、不碰工作区。

/** 用给定源码文本渲染（与 renderVoiceSection 同环境，仅源码不同）。 */
function renderWithSource(src, cfg) {
  const ReactStub = {
    createElement: (type, props, ...kids) => {
      const flat = kids.flat(9).filter((k) => k !== null && k !== undefined && k !== false);
      const pr = Object.assign({}, props || {});
      if (flat.length) pr.children = flat.length === 1 ? flat[0] : flat;
      return { type, props: pr, kids: flat };
    },
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useRef: (init) => ({ current: init }),
    useEffect: () => {},
  };
  const S = loadState();
  S.voiceCfgState.value = Object.assign({}, S.VOICE_CFG_DEFAULTS, { vad: { enabled: true, silenceMs: 3000 } }, cfg || {});
  const factory = new Function(
    'React', 'makeT', 'host', 'voiceCfgState', 'subscribeVoiceConfig', 'saveVoiceCfg', 'syncVoiceFromHost',
    'vadSilenceMsOf', 'normalizeVadSilenceMs', 'CollapsibleSection',
    'voiceHotkeyDisplay',
    'setTimeout', 'clearTimeout', 'window',
    src + ';return { VoiceSection };'
  );
  const api = factory(
    ReactStub, () => (k) => k, { call: () => Promise.resolve({ ok: false }) },
    S.voiceCfgState, () => () => {}, (patch) => { S.saveVoiceCfg(patch); },
    () => {}, S.vadSilenceMsOf, S.normalizeVadSilenceMs,
    (p) => ReactStub.createElement('section', {}, p.children),
    (c) => String(c || ''),
    setTimeout, clearTimeout, {}
  );
  const expand = (n) => {
    if (!n || typeof n !== 'object') return n;
    if (typeof n.type === 'function') { const o = n.type(n.props); return o ? expand(o) : null; }
    return { type: n.type, props: n.props, kids: (n.kids || []).map(expand).filter(Boolean) };
  };
  const tree = expand(api.VoiceSection({}));
  const section = tree.kids[0];
  return { section, vadSelect: selectByLabel(section, 'voiceVadShort'), S };
}

test('VADSIL-P14x-1 变异①：档位候选拼回「开 ·」=> P14d 必红（判据有牙）', () => {
  const src = voiceModules.voiceSectionSource();
  const anchor = "{ value: 'off', text: OFF_TEXT }";
  assert.ok(src.includes(anchor), '前置：候选首项锚点须在位');
  // 把「1 秒」档的文案拼上「开 ·」（模拟用户点名要删的那个前缀回来）
  const mutated = src.replace("text: n + ' ' + t('voiceVadSilenceUnit')",
    "text: t('voiceAutoEnhanceOn') + ' · ' + n + ' ' + t('voiceVadSilenceUnit')");
  assert.notEqual(mutated, src, '前置：变异锚点须命中');
  const mu = renderWithSource(mutated, {});
  const opts = mu.vadSelect.kids.filter((k) => k && k.type === 'option');
  const texts = opts.slice(1).map((o) => String(o.props.children)).join('|');
  assert.equal(/voiceAutoEnhanceOn/.test(texts), true,
    '变异后档位文案含开键 => P14d 的「不得拼开/关」断言必红（判据有牙）');
});

test('VADSIL-P14x-2 变异②：选关时把 silenceMs 写成 0 => P14c 必红（判据有牙）', () => {
  const src = voiceModules.voiceSectionSource();
  // 本批语义收敛后，「选关」的写入语句变成带全同段字段的一行；变异 = 把 silenceMs 换成 0
  const anchor = "saveVoiceCfg({ vad: { enabled: false, silenceMs: normalizeVadSilenceMs(vd.silenceMs), floorDb: vd.floorDb, floorMeasuredAt: vd.floorMeasuredAt } });";
  assert.ok(src.includes(anchor), '前置：onVadPick 的「关」写入锚点须在位');
  const mutated = src.replace(anchor,
    "saveVoiceCfg({ vad: { enabled: false, silenceMs: 0, floorDb: vd.floorDb, floorMeasuredAt: vd.floorMeasuredAt } });");
  assert.notEqual(mutated, src, '前置：变异锚点须命中');
  const mu = renderWithSource(mutated, { vad: { enabled: true, silenceMs: 5000 } });
  mu.vadSelect.props.onChange({ target: { value: 'off' } });
  // 变异后 silenceMs 归一为 2000（0 非法 => 回落），不再是 5000 => P14c 的「不得改动 silenceMs」断言必红
  assert.equal(mu.S.voiceCfgState.value.vad.silenceMs !== 5000, true,
    '变异后 silenceMs 不再是 5000 => P14c 必红（判据有牙）');
});

test('VADSIL-P14x-3 变异③：下拉首项改成「开」而非「关」=> P14 必红（判据有牙）', () => {
  const src = voiceModules.voiceSectionSource();
  // 只改静音监测那一处候选（其余三处保持，证明判据是**按项**判的）
  const anchor = "const vadOptions = [{ value: 'off', text: OFF_TEXT }]";
  assert.ok(src.includes(anchor), '前置：vadOptions 锚点须在位');
  const mutated = src.replace(anchor, "const vadOptions = [{ value: 'on', text: OFF_TEXT }]");
  assert.notEqual(mutated, src, '前置：变异锚点须命中');
  const mu = renderWithSource(mutated, {});
  const first = mu.vadSelect.kids.filter((k) => k && k.type === 'option')[0];
  assert.equal(first.props.value, 'on', '变异后首项值为 on => P14 的「首项须是 off」断言必红（判据有牙）');
});

test('VADSIL-P14x-4 负控：不动任何文件 => P14 系列全绿（防"恒红"）', () => {
  const { vadSelect } = layoutRows({ vad: { enabled: true, silenceMs: 3000 } });
  assert.ok(vadSelect, '负控：静音监测下拉在位');
  assert.equal(vadSelect.props.value, '3', '负控：3 秒档值正确');
  const opts = vadSelect.kids.filter((k) => k && k.type === 'option');
  assert.equal(opts.length, 6, '负控：6 个候选');
});


test('VADSIL-P15 i18n：新增 3 键且 ZH/EN 键集相等（S-7）', () => {
  const i18n = i18nSource();
  for (const k of ['voiceVadSilenceLabel', 'voiceVadSilenceUnit', 'voiceVadSilenceHint']) {
    assert.ok(i18n.includes(k + ':'), 'i18n 缺键 ' + k);
  }
  const zh = i18n.split('const EN = {')[0];
  const en = 'const EN = {' + i18n.split('const EN = {')[1];
  const pattern = (s) => (s.match(/voiceVad[A-Za-z]*:/g) || []).sort();
  assert.deepEqual(pattern(zh), pattern(en), 'voiceVad* ZH/EN 键集必须相等（S-7）');
  assert.equal(pattern(zh).length, 5, 'voiceVad* 键数锁定 5（enabled/short + 新增 3，严格 ===）');
});

test('VADSIL-P16 VAD_POLL_MS 未被暴露为可调项（§7.4 明确：不暴露）', () => {
  const S = loadState();
  const vs = voiceModules.voiceSectionSource();
  assert.equal(S.VOICE_CFG_DEFAULTS.vad.pollMs, undefined, '配置面不得出现 pollMs');
  assert.equal(/pollMs/.test(vs), false, 'UI 不得有轮询间隔控件');
  // 轮询间隔仍是官方桥内的实现细节常量（100ms），不随配置变化。
  const br = voiceModules.officialBridgeSource();
  assert.ok(br.includes('OVB_POLL_MS = 100'), '轮询间隔须仍是 100ms 实现常量');
});

// ───────────── 变异自证 ─────────────
// 变异名运行时拼接；正例必红、负控必绿。
function mutate(src, kind) {
  // 目标模式：默认值来自共享契约显式注入。
  // 变异仍打在「默认值」这一个事实上，只是位置随事实源迁移。
  const contractDefaults = require('../src/shared/contracts/voice-config.cjs').VOICE_CONFIG_DEFAULTS;
  const A = 'const __VOICE_CONFIG_DEFAULTS__ = ' + JSON.stringify(contractDefaults) + ';\n';
  if (kind === 'kill-default') {
    // 默认值被改 → 默认行为双读数必红
    assert.ok(src.includes(A), '变异锚点须存在');
    const mutated = JSON.parse(JSON.stringify(contractDefaults));
    mutated.vad.silenceMs = 3000;
    return src.replace(A, 'const __VOICE_CONFIG_DEFAULTS__ = ' + JSON.stringify(mutated) + ';');
  }
  if (kind === 'freeze-frames') {
    // 帧数退回固定常量派生（不再动态）→ P03 必须红
    const anchor = '    const poll = 100; // = 录音轮询粒度（内部实现，不对外暴露）\n    return Math.max(1, Math.round(ms / poll));';
    assert.ok(src.includes(anchor), '变异锚点须存在');
    const m = src.replace(anchor, '  const poll = 100;\n  return 20;');
    // 同时摘掉归一化，避免被归一化掩盖
    return m;
  }
  throw new Error('unknown mutation kind');
}

function loadMutantState(kind) {
  const src = mutate(voiceStateChunkWithDefaults(), kind);
  const lsBacking = new Map();
  const localStorageStub = { getItem: (k) => (lsBacking.has(k) ? lsBacking.get(k) : null), setItem: (k, v) => lsBacking.set(k, String(v)), removeItem: (k) => lsBacking.delete(k) };
  const factory = new Function('localStorage', 'host', src + '\n;return { normalizeVadSilenceMs, vadRequiredQuiet };');
  return factory(localStorageStub, { call: () => Promise.resolve({ ok: false }) });
}

test('VADSIL-V01 变异自证·正例必红：改默认值 ⇒ 默认双读数判据必须失败', () => {
  const M = loadMutantState('kill-default');
  // 默认双读数判据在变异下必须为红
  const wouldPass = (M.normalizeVadSilenceMs(undefined) === 2000 && M.vadRequiredQuiet(undefined) === 20);
  assert.equal(wouldPass, false, '变异后「默认 = 2 秒」判据必须红（若仍绿 ⇒ 判据没牙）');
});

test('VADSIL-V02 变异自证·负控必绿：同一变异下「合法档位接受」判据仍须通过', () => {
  const M = loadMutantState('kill-default');
  // 负控：合法值路径与默认值无关，必须仍绿
  assert.equal(M.normalizeVadSilenceMs(1000), 1000, '负控·1 秒仍接受');
  assert.equal(M.normalizeVadSilenceMs(5000), 5000, '负控·5 秒仍接受');
  assert.equal(M.vadRequiredQuiet(3000), 30, '负控·3 秒仍 → 30 帧');
});

test('VADSIL-V03 变异自证·正例必红：帧数退回固定常量 ⇒ 动态性判据必须失败', () => {
  const M = loadMutantState('freeze-frames');
  const frames = [1000, 2000, 3000, 4000, 5000].map((ms) => M.vadRequiredQuiet(ms));
  const wouldPass = (new Set(frames).size === 5);
  assert.equal(wouldPass, false, '帧数被回退为常量后「5 档互不相同」判据必须红');
});

test('VADSIL-V04 变异自证·负控必绿：同一变异下非法值回落判据仍须通过', () => {
  const M = loadMutantState('freeze-frames');
  // 负控：非法值回落走归一化，与帧数派生无关，必须仍绿
  for (const v of [0, 6, 1.5, 'x', null]) {
    assert.equal(M.normalizeVadSilenceMs(v), 2000, '负控·非法值 ' + JSON.stringify(v) + ' 仍回落 2000');
  }
});
