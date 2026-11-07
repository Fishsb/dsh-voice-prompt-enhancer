'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { VOICE_CONFIG_KEYS, VOICE_CONFIG_DEFAULTS, cloneVoiceConfigDefaults, normalizeVadSilenceMs } = require('../src/shared/contracts/voice-config.cjs');
const { voiceStateChunkWithDefaults } = require('./helpers/voice-state-chunk.cjs');

function loadVoiceState() {
  const src = voiceStateChunkWithDefaults();
  const ls = new Map();
  const localStorage = { getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: (k) => ls.delete(k) };
  const factory = new Function('localStorage', 'host', src + '\n;return { VOICE_CFG_DEFAULTS };');
  return factory(localStorage, { call: () => Promise.resolve({ ok: false }) });
}

test('VCONF-01 键集合与 client domains/voice/state.cjs 同形', () => {
  const actual = loadVoiceState().VOICE_CFG_DEFAULTS;
  assert.deepEqual([...VOICE_CONFIG_KEYS].sort(), Object.keys(actual).sort());
});

test('VCONF-02 默认值与 client domains/voice/state.cjs 逐字段相等', () => {
  const actual = loadVoiceState().VOICE_CFG_DEFAULTS;
  assert.deepEqual(JSON.parse(JSON.stringify(VOICE_CONFIG_DEFAULTS)), actual);
});

test('VCONF-03 clone 返回独立副本，修改不污染事实源', () => {
  const a = cloneVoiceConfigDefaults();
  a.filler.enabled = false;
  assert.equal(VOICE_CONFIG_DEFAULTS.filler.enabled, true);
  assert.equal(cloneVoiceConfigDefaults().filler.enabled, true);
});

test('VCONF-04 事实源冻结', () => {
  assert.equal(Object.isFrozen(VOICE_CONFIG_KEYS), true);
  assert.equal(Object.isFrozen(VOICE_CONFIG_DEFAULTS), true);
});

test('VCONF-05 产物面：共享运行时已由打包器注入且只注入一次（状态模块不再自带第二份）', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const client = fs.readFileSync(path.join(__dirname, '..', 'lib', 'client.cjs'), 'utf8');
  for (const mod of ['src/shared/contracts/voice-config.cjs', 'src/shared/voice/postprocess-plan.cjs', 'src/shared/contracts/client-runtime.cjs']) {
    assert.ok(client.includes('"' + mod + '"'), '共享运行时模块 id 未内联：' + mod);
  }
  assert.ok(client.includes('defaults: contracts.VOICE_CONFIG_DEFAULTS'), '状态模块的默认值必须来自共享契约');
  assert.ok(client.includes('src/client/domains/voice/state.cjs'), '产物须内联语音状态普通模块');
  assert.equal(client.includes("require('../src/shared/contracts/"), false, '产物不得保留外部 require');
  assert.equal(client.includes("require('../src/shared/voice/"), false, '产物不得保留外部 require');
});

test('VCONF-06 VAD 档位归一为契约单一入口：client 与 host 同值', () => {
  const asr = require('../lib/asr.cjs');
  for (const input of [1, 2, 3, 4, 5, 1000, 3000, 5000]) {
    assert.equal(normalizeVadSilenceMs(input), input <= 5 ? input * 1000 : input, '契约合法值：' + input);
  }
  for (const input of [0, 6, 1.5, '3000', null, undefined, NaN, -1000]) {
    assert.equal(normalizeVadSilenceMs(input), VOICE_CONFIG_DEFAULTS.vad.silenceMs, '契约非法值回落：' + String(input));
    assert.equal(asr.sanitizeVoiceCfg({ vad: { silenceMs: input } }).vad.silenceMs,
      VOICE_CONFIG_DEFAULTS.vad.silenceMs, 'host 必须与契约同值：' + String(input));
  }
  assert.equal(asr.sanitizeVoiceCfg({ vad: { silenceMs: 5000 } }).vad.silenceMs, 5000);
});

test('VCONF-07 发布物自包含：运行时模块不得引用 src/，npm pack 必须带 lib/voice-config.cjs', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.ok(pkg.files.includes('lib'), '发布白名单必须包含 lib/');
  const asr = fs.readFileSync(path.join(root, 'lib', 'asr.cjs'), 'utf8');
  assert.equal(/require\(['"]\.\.\/src\//.test(asr), false, 'lib/ 运行时模块不得引用 src/（安装包不含 src/）');
  assert.equal(/require\(['"]\.\/voice-config\.cjs['"]\)/.test(asr), true, 'asr 必须从 lib/voice-config.cjs 取契约');
  // 发布白名单只含 lib/ ⇒ lib/voice-config.cjs 必然随包；这条用真实清单锁定，不依赖 npm 可执行文件路径。
  assert.ok(pkg.files.some((entry) => entry === 'lib' || entry.startsWith('lib/')), 'lib/voice-config.cjs 必须落在发布白名单内');
});

// ─────────── O4 / UD-0052（2026-11-08 · 语音四件收口批）：两份白名单同批同形 ───────────
// 病历（`CHG-115` `M-3`）：host `sanitizeVoiceCfg` 与 client `mergeVoice` 是**两份独立白名单**，
//   只改一侧 ⇒ 该字段在保存链路被静默剥掉（用户改了不生效，且没有任何提示）。
//   本锁对同一输入逐键比对 `correction` 段与 `autoEnhanceMode`，任一侧漏改即红。
const { sanitizeVoiceCfg } = require('../lib/asr.cjs');
const { createVoiceState } = require('../src/client/domains/voice/state.cjs');
const { RPC_METHODS } = require('../src/shared/contracts/rpc.cjs');
const { normalizeAutoEnhanceMode, normalizeCorrectionWindowRounds } = require('../src/shared/contracts/voice-config.cjs');

function clientMergeVoice() {
  const api = createVoiceState({
    host: { call: () => Promise.resolve({ ok: false }) },
    storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    defaults: VOICE_CONFIG_DEFAULTS,
    rpcMethods: RPC_METHODS,
    normalizeAutoEnhanceMode,
    normalizeCorrectionWindowRounds,
    autoSync: false,
  });
  return api.mergeVoice;
}

test('VCONF-08 ⭐O4 两份白名单同形：correction 段逐键相等（含 windowRounds 归一）', () => {
  const mergeVoice = clientMergeVoice();
  const inputs = [
    {},
    { correction: { enabled: true } },
    { correction: { enabled: true, windowRounds: 1 } },
    { correction: { enabled: false, windowRounds: 2 } },
    { correction: { enabled: true, windowRounds: 3 } },
    { correction: { enabled: true, windowRounds: 0 } },
    { correction: { enabled: true, windowRounds: 9 } },
    { correction: { enabled: true, windowRounds: null } },
    { correction: { enabled: 'yes', windowRounds: 2.5 } },
    { correction: null },
  ];
  for (const input of inputs) {
    const host = sanitizeVoiceCfg(input).correction;
    const client = mergeVoice(input).correction;
    assert.deepEqual(client, host, 'correction 段必须逐键相等（M-3）；输入 ' + JSON.stringify(input));
    assert.deepEqual(Object.keys(client).sort(), ['enabled', 'windowRounds'], 'correction 键集固定为 enabled + windowRounds');
  }
});

test('VCONF-09 ⭐UD-0052 两份白名单同形：autoEnhanceMode 归一逐值相等', () => {
  const mergeVoice = clientMergeVoice();
  const inputs = [undefined, null, '', 'lite', 'smart', 'publish', 'base', 'standard', 'foo', 42, 'MEMORY'];
  for (const value of inputs) {
    const host = sanitizeVoiceCfg({ autoEnhanceMode: value }).autoEnhanceMode;
    const client = mergeVoice({ autoEnhanceMode: value }).autoEnhanceMode;
    assert.equal(client, host, 'autoEnhanceMode 必须两侧同值；输入 ' + JSON.stringify(value));
  }
  // 值域 = 五模式 + 空串；其余一律落空串（= 跟随全局，默认行为）
  assert.equal(sanitizeVoiceCfg({ autoEnhanceMode: 'lite' }).autoEnhanceMode, 'lite');
  for (const bad of ['foo', 42, null, undefined, 'MEMORY', 'LITE']) {
    assert.equal(sanitizeVoiceCfg({ autoEnhanceMode: bad }).autoEnhanceMode, '', '非法值须落空串：' + String(bad));
  }
});

test('VCONF-10 默认值：autoEnhanceMode 空串 + correction.windowRounds 1（不改既有默认行为）', () => {
  assert.equal(VOICE_CONFIG_DEFAULTS.autoEnhanceMode, '');
  assert.equal(VOICE_CONFIG_DEFAULTS.correction.windowRounds, 1);
  assert.equal(VOICE_CONFIG_DEFAULTS.correction.enabled, false);
  assert.ok(VOICE_CONFIG_KEYS.includes('autoEnhanceMode'), 'VOICE_CONFIG_KEYS 须含 autoEnhanceMode');
});
