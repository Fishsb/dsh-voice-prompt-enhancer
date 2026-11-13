'use strict';

// UD-0055 / UD-0057（学习词典）七项验收。
// 纪律：本批只加「学习词典」这一条链路；⛔ 不改纠错提示词、⛔ 不改 VOICE_CORRECT 调用形态。

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  VOICE_CONFIG_KEYS,
  VOICE_CONFIG_DEFAULTS,
  VOICE_DICTIONARY_MAX_ENTRIES,
  VOICE_DICTIONARY_MAX_TERM,
  normalizeDictionaryEntries,
  matchVoiceDictionary,
  recordVoiceDictionaryHits,
  VOICE_DICTIONARY_PROMPT_MAX_HITS,
  learnVoiceDictionaryDiff,
} = require('../src/shared/contracts/voice-config.cjs');
const { sanitizeVoiceCfg } = require('../lib/asr.cjs');
const { voiceStateChunkWithDefaults } = require('./helpers/voice-state-chunk.cjs');

function loadVoiceStateModule() {
  const src = voiceStateChunkWithDefaults();
  const ls = new Map();
  const localStorage = {
    getItem: (k) => (ls.has(k) ? ls.get(k) : null),
    setItem: (k, v) => ls.set(k, String(v)),
    removeItem: (k) => ls.delete(k),
  };
  // 与生产装配同形：把契约层的归一实现注入（`src/client/app.cjs` 也是这么传的）
  const factory = new Function('localStorage', 'host', 'normalizeDictionaryEntries', src + '\n;return { VOICE_CFG_DEFAULTS, mergeVoice };');
  return factory(localStorage, { call: () => Promise.resolve({ ok: false }) }, normalizeDictionaryEntries);
}

// ── ① 双白名单同形（`M-3`）：host `sanitizeVoiceCfg` ↔ client `mergeVoice` ───────────────
test('VDICT-01 host 白名单与 client 白名单在 dictionary 上同形同值', () => {
  const input = {
    filler: { enabled: true },
    vad: { enabled: true, silenceMs: 2000 },
    hotkey: { enabled: false, combo: '' },
    autoEnhance: false,
    correction: { enabled: false },
    dictionary: { entries: [{ from: 'AB', to: 'AC' }, { from: 'AB', to: 'AC' }] },
  };
  const host = sanitizeVoiceCfg(input);
  const client = loadVoiceStateModule().mergeVoice(input);
  assert.deepEqual(Object.keys(host).sort(), Object.keys(client).sort());
  assert.deepEqual(host.dictionary, client.dictionary);
  assert.equal(host.dictionary.entries.length, 1, '重复 from 必须合并成一条');
  assert.ok(VOICE_CONFIG_KEYS.includes('dictionary'));
  assert.ok(Object.prototype.hasOwnProperty.call(VOICE_CONFIG_DEFAULTS, 'dictionary'));
});

// ── ② 词库只挑「命中的条目」，不产生任何替换结果（CHG-390）─────────────────────
// 设计口径（用户 2026-11-13）：硬替换会在不合适场景误替换 ⇒ 替换决策交模型，契约层只做筛选。
test('VDICT-02 空词典 / 全停用 / 无命中 ⇒ 命中列表为空（不产生替换结果）', () => {
  const text = '这是一段需要保持完全不变的话，ABCD。';
  assert.deepEqual(matchVoiceDictionary(text, []), []);
  assert.deepEqual(matchVoiceDictionary(text, [{ from: 'ABCD', to: 'abdc', enabled: false }]), []);
  assert.deepEqual(matchVoiceDictionary(text, [{ from: '不存在的词', to: 'x' }]), []);
  assert.deepEqual(matchVoiceDictionary('', [{ from: 'ABCD', to: 'abdc' }]), []);
  assert.deepEqual(matchVoiceDictionary(null, [{ from: 'ABCD', to: 'abdc' }]), []);
  // 纯函数：不改入参、不返回被改写的文本
  const entries = [{ from: 'ABCD', to: 'abdc', hits: 0, at: 1, enabled: true }];
  const snapshot = JSON.parse(JSON.stringify(entries));
  matchVoiceDictionary(text, entries);
  assert.deepEqual(entries, snapshot, '命中筛选不得修改入参（尤其不得回写 hits）');
});

// ── ③ 形近筛子 ───────────────────────────────────────────────────────────────
test('VDICT-03 形近筛子：等长或长度差 ≤2 收，差 >2 / from===to / 超长 丢', () => {
  const kept = normalizeDictionaryEntries([
    { from: 'abc', to: 'abd' },
    { from: 'abcd', to: 'ab' },
    { from: 'ab', to: 'abcd' },
  ]);
  assert.equal(kept.length, 3, '长度差 0/2/2 都在筛内');
  const dropped = normalizeDictionaryEntries([
    { from: 'ab', to: 'abcde' },
    { from: 'same', to: 'same' },
    { from: 'x'.repeat(VOICE_DICTIONARY_MAX_TERM + 1), to: 'y' },
    { from: '', to: 'z' },
  ]);
  assert.deepEqual(dropped, []);
});

// ── ④ 重复合并（hits 累加 / at 取大 / enabled 取或）──────────────────────────────
test('VDICT-04 同 from 合并：hits 累加、at 取较大、enabled 取或', () => {
  const out = normalizeDictionaryEntries([
    { from: 'hellp', to: 'hello', hits: 2, at: 100, enabled: false },
    { from: 'hellp', to: 'hello', hits: 3, at: 900, enabled: true },
    { from: 'hellp', to: 'hello', hits: 1, at: 500, enabled: false },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].hits, 6);
  assert.equal(out[0].at, 900);
  assert.equal(out[0].enabled, true);
});

// ── ⑤ 上限与淘汰 ─────────────────────────────────────────────────────────────
test('VDICT-05 超过上限按 hits 降序 + at 降序淘汰', () => {
  const many = [];
  for (let i = 0; i < VOICE_DICTIONARY_MAX_ENTRIES + 25; i += 1) {
    many.push({ from: 'w' + i, to: 'v' + i, hits: i, at: 1000 + i, enabled: true });
  }
  const out = normalizeDictionaryEntries(many);
  assert.equal(out.length, VOICE_DICTIONARY_MAX_ENTRIES);
  assert.equal(out[0].hits, VOICE_DICTIONARY_MAX_ENTRIES + 24, '命中最多者必须留下');
  assert.ok(out.every((e, i) => i === 0 || out[i - 1].hits >= e.hits), '必须按 hits 降序');
});

// ── ⑥ 命中筛选的边界：长词优先、上限截断、只挑字面出现 ─────────────────────────
test('VDICT-06 命中筛选：长词优先排序、上限截断、只挑草稿里出现的', () => {
  const text = '今天开会说 recieve 这个词，然后 recieve 又出现一次。';
  const hits = matchVoiceDictionary(text, [
    { from: 'recieve', to: 'receive', enabled: true },
    { from: 'recieve 这个', to: 'receive 这个', enabled: true },
    { from: '没出现的词', to: 'x', enabled: true },
  ]);
  assert.equal(hits.length, 2, '只挑确实出现的两条');
  assert.equal(hits[0].from, 'recieve 这个', '长词排在前面');
  assert.equal(hits[1].from, 'recieve');

  // 上限：超出 VOICE_DICTIONARY_PROMPT_MAX_HITS 的部分被截断（防提示词膨胀）
  const many = [];
  for (let i = 0; i < VOICE_DICTIONARY_PROMPT_MAX_HITS + 6; i += 1) {
    many.push({ from: 'w' + String.fromCharCode(97 + (i % 26)), to: 'x', enabled: true });
  }
  const bullet = many.map((e) => e.from).join(' ');
  const capped = matchVoiceDictionary(bullet, many);
  assert.ok(capped.length <= VOICE_DICTIONARY_PROMPT_MAX_HITS, '命中条数必须有上限');
});

test('VDICT-06b 生效计数：模型实际改对才 +1，改动不彻底不计', () => {
  const e = [{ from: '绘画', to: '会话', hits: 0, at: 1, enabled: true }];
  const ok = recordVoiceDictionaryHits('这个绘画很重要', '这个会话很重要', e, 500);
  assert.equal(ok[0].hits, 1, '改对了 ⇒ hits +1');
  assert.equal(ok[0].at, 500, 'at 更新为本次时刻（用于淘汰排序）');

  assert.equal(recordVoiceDictionaryHits('这个绘画很重要', '这个绘画很重要', e, 500)[0].hits, 0, '没改 ⇒ 不计');
  assert.equal(recordVoiceDictionaryHits('这个绘画很重要', '这个会话还会绘画', e, 500)[0].hits, 0, '原写法仍在 ⇒ 不计');
  assert.equal(recordVoiceDictionaryHits('无关文本', '会话', e, 500)[0].hits, 0, '原文没出现 ⇒ 不计');
  // 停用条目不计数
  const disabled = [{ from: '绘画', to: '会话', hits: 3, at: 1, enabled: false }];
  assert.equal(recordVoiceDictionaryHits('这个绘画', '这个会话', disabled, 500)[0].hits, 3, '停用条目不累加');
  // 纯函数：不改入参
  const snapshot = JSON.parse(JSON.stringify(e));
  recordVoiceDictionaryHits('这个绘画', '这个会话', e, 500);
  assert.deepEqual(e, snapshot, '不得修改入参');
});

// ── ⑦ 采集：机器输出 → 用户手改 的差异学习 ───────────────────────────────────
test('VDICT-07 差异学习：换词入库、纯插入/纯删除不入库、超长不入库', () => {
  const learned = learnVoiceDictionaryDiff('这个功能很好', '这个特性很好');
  assert.equal(learned.length, 1);
  assert.equal(learned[0].from, '功能');
  assert.equal(learned[0].to, '特性');
  assert.equal(learned[0].hits, 1);
  assert.equal(learned[0].enabled, true);
  assert.deepEqual(learnVoiceDictionaryDiff('请打开设置页', '请打开设置页谢谢'), [], '纯插入不入库');
  assert.deepEqual(learnVoiceDictionaryDiff('请打开设置页谢谢', '请打开设置页'), [], '纯删除不入库');
  assert.deepEqual(learnVoiceDictionaryDiff('ab', 'a'.repeat(VOICE_DICTIONARY_MAX_TERM + 5)), [], '超长不入库');
  assert.deepEqual(learnVoiceDictionaryDiff('请打开设置页', '请打开设备页'), [], '单字差异不入库（噪声面）');
  assert.deepEqual(learnVoiceDictionaryDiff('同', '同'), []);
  assert.deepEqual(learnVoiceDictionaryDiff(null, ''), []);
});