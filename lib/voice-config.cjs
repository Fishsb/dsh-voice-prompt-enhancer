'use strict';

// 语音配置契约（发布物内自包含的纯数据模块）。
// ⚠ 本文件是 `src/shared/contracts/voice-config.cjs` 的唯一实现来源；
//   发布白名单只含 `lib/`，因此运行时模块必须从 lib/ 取用，不得 require src/。
const VOICE_CONFIG_KEYS = Object.freeze(['filler', 'vad', 'hotkey', 'autoEnhance', 'autoEnhanceMode', 'correction', 'dictionary']);
const VOICE_CONFIG_DEFAULTS = Object.freeze({
  filler: Object.freeze({ enabled: true }),
  // floorDb（2026-11-12 · Issue #15 后续）：**实测**环境噪声下限（dBFS）。
  //   null = 未测过 ⇒ 该层不生效，行为与既有完全一致（向后兼容）。
  //   由设置面板的「测试环境噪声」按钮写入：3 秒采样 p95 + 5 dB。
  vad: Object.freeze({ enabled: true, silenceMs: 2000, floorDb: null, floorMeasuredAt: 0 }),
  hotkey: Object.freeze({ enabled: false, combo: '' }),
  autoEnhance: false,
  // UD-0052（2026-11-08 · 语音四件收口批）：语音自动增强的**档位**独立于全局 `config.mode`。
  //   空串 = 跟随全局（默认行为，⛔ 不得改）；其余为 MODE_KEYS 五值之一。
  autoEnhanceMode: '',
  // windowRounds（2026-11-08 · O4）：纠错参考窗口轮数（1–3），默认 1 = 既有行为。
  correction: Object.freeze({ enabled: false, windowRounds: 1 }),
  // 学习词典（UD-0055 / UD-0057）：识别完成后记录用户手改，形近替换自动生效。
  //   entries: { from, to, hits, at, enabled } —— 纯字面替换，⛔ 不碰纠错提示词。
  dictionary: Object.freeze({ entries: Object.freeze([]) }),
});

function cloneVoiceConfigDefaults() {
  return JSON.parse(JSON.stringify(VOICE_CONFIG_DEFAULTS));
}

// 增强模式键（与 `lib/contracts.cjs` 的 `MODE_KEYS` 同值；此处独立声明是为了让
//   `lib/voice-config.cjs` 保持**零 require**（发布物内自包含的纯数据模块）。
const VOICE_ENHANCE_MODES = Object.freeze(['base', 'lite', 'standard', 'smart', 'publish']);

// 语音自动增强档位归一（UD-0052）：五值之一，其余（含缺省/非法/非字符串）一律落空串 = 跟随全局。
function normalizeAutoEnhanceMode(v) {
  return typeof v === 'string' && VOICE_ENHANCE_MODES.indexOf(v) >= 0 ? v : '';
}

// 纠错参考窗口轮数归一（O4）：1–3 整数，其余（含 0 / 9 / null / 缺省）回落 1。
function normalizeCorrectionWindowRounds(v) {
  const n = typeof v === 'number' ? v : NaN;
  if (Number.isInteger(n) && n >= 1 && n <= 3) return n;
  return VOICE_CONFIG_DEFAULTS.correction.windowRounds;
}

// 静音档位归一：1–5 秒整数（毫秒写法 1000–5000 的整千倍）合法，其余回落默认。
function normalizeVadSilenceMs(v) {
  const n = typeof v === 'number' ? v : NaN;
  if (Number.isInteger(n)) {
    if (n >= 1000 && n <= 5000 && n % 1000 === 0) return n;
    if (n >= 1 && n <= 5) return n * 1000;
  }
  return VOICE_CONFIG_DEFAULTS.vad.silenceMs;
}

// 环境噪声下限归一（2026-11-12）：dBFS 合理域 = [-100, 0]。
//   非有限数 / 越界 / 非数字 ⇒ 一律回落 null（= 未测过，该层不生效）。
//   ⚠ 用 null 而非 0 作「未设置」哨兵：0 dBFS 是满量程，是合法但极端的值，不能兼作哨兵。
function normalizeVadFloorDb(v) {
  const n = typeof v === 'number' ? v : NaN;
  if (!Number.isFinite(n)) return null;
  if (n < -100 || n > 0) return null;
  return Math.round(n * 10) / 10;   // 0.1 dB 精度足够，避免浮点噪声写入配置
}


// ── 学习词典（UD-0055 / UD-0057）────────────────────────────────────────────
// 口径（单一事实源；host `sanitizeVoiceCfg` 与 client `mergeVoice` 同批同形取用）：
//   · 单条词长 ≤ 20 字；形近筛子 = 等长或长度差 ≤ 2；from === to 无意义 ⇒ 丢弃。
//   · 重复 from 合并：hits 累加、at 取较大值、enabled 取「或」（任一启用即启用）。
//   · 淘汰 = 按 hits 降序 + at 降序，上限 VOICE_DICTIONARY_MAX_ENTRIES。
//   · 替换 = 纯字面（split/join），⛔ 不用正则（避免把用户词当模式）；长 from 先替换。
const VOICE_DICTIONARY_MAX_ENTRIES = 500;
const VOICE_DICTIONARY_MAX_TERM = 20;

function dictionaryTerm(value) {
  if (typeof value !== 'string') return '';
  const s = value.trim();
  if (!s || s.length > VOICE_DICTIONARY_MAX_TERM) return '';
  return s;
}

function normalizeDictionaryEntries(list) {
  const arr = Array.isArray(list) ? list : [];
  const byFrom = new Map();
  for (let i = 0; i < arr.length; i += 1) {
    const raw = arr[i] && typeof arr[i] === 'object' ? arr[i] : null;
    if (!raw) continue;
    const from = dictionaryTerm(raw.from);
    const to = dictionaryTerm(raw.to);
    if (!from || !to || from === to) continue;
    if (Math.abs(from.length - to.length) > 2) continue;
    const hits = Number.isInteger(raw.hits) && raw.hits > 0 ? raw.hits : 0;
    const at = typeof raw.at === 'number' && isFinite(raw.at) && raw.at > 0 ? raw.at : 0;
    const enabled = raw.enabled !== false;
    const prev = byFrom.get(from);
    if (prev) {
      prev.hits += hits;
      if (at > prev.at) prev.at = at;
      if (enabled) prev.enabled = true;
      continue;
    }
    byFrom.set(from, { from: from, to: to, hits: hits, at: at, enabled: enabled });
  }
  const entries = Array.from(byFrom.values());
  entries.sort((a, b) => (b.hits - a.hits) || (b.at - a.at));
  return entries.slice(0, VOICE_DICTIONARY_MAX_ENTRIES);
}

// ── 词库「命中筛选」与「生效计数」（CHG-390 · 2026-11-13 · 词库改作纠错参考）──────────
// 设计口径（用户 2026-11-13 逐字）：词库**不是**独立的字面替换器，而是**纠错步的参考输入**——
//   「纠错如果根据词库只要命中就替换的话可能在不合适的场景也会被错误的替换，所以词库是需要让模型
//    带入参考去替换的，大模型纠错的时候把命中的替换词带入进去作为参考，提升纠错的准确率」。
// ⇒ 原 `applyVoiceDictionary`（命中即硬替换）**整体删除**：它会把「不合适场景」也替换掉，
//   正是用户点名要避免的形态；替换决策改由纠错模型在提示词内结合上下文作出。
//   本文件只保留两件**不下判断**的纯函数：① 挑出草稿里命中的词条（喂给提示词）；
//   ② 事后的生效计数（模型确实改对了才 +1，供设置页「命中」列显示真数）。
const VOICE_DICTIONARY_PROMPT_MAX_HITS = 12;

// 命中筛选：只保留「草稿里确实出现了 from 的字面」且启用的条目。
// ⚠ 只判**字面出现**，不判断该不该替换 —— 那正是模型的活（本函数不产生任何替换结果）。
// 返回按 from 降序长度排序（长词优先，避免短词抢先遮蔽长词），最多 VOICE_DICTIONARY_PROMPT_MAX_HITS 条。
function matchVoiceDictionary(text, entries) {
  const src = typeof text === 'string' ? text : '';
  if (!src) return [];
  const list = normalizeDictionaryEntries(entries).filter((e) => e.enabled === true);
  const hits = [];
  for (let i = 0; i < list.length; i += 1) {
    if (src.indexOf(list[i].from) !== -1) hits.push(list[i]);
  }
  hits.sort((a, b) => (b.from.length - a.from.length) || (a.from < b.from ? -1 : 1));
  return hits.slice(0, VOICE_DICTIONARY_PROMPT_MAX_HITS);
}

// 生效计数（用户 2026-11-13 拍板）：**模型实际改对了才计**。
// 判据（保守、纯字面）：原文含 from、结果含 to、且结果已不再含 from ⇒ 视为这一次改对了。
//   ⚠ 只用于「命中」列的显示与淘汰排序，**不参与**任何替换决策。
// 返回新数组（不改入参）；未生效的条目原样保留。
function recordVoiceDictionaryHits(originalText, resultText, entries, now) {
  const before = typeof originalText === 'string' ? originalText : '';
  const after = typeof resultText === 'string' ? resultText : '';
  const list = normalizeDictionaryEntries(entries);
  if (!before || !after || before === after) return list;
  const at = typeof now === 'number' && isFinite(now) && now > 0 ? now : Date.now();
  return list.map((e) => {
    if (e.enabled !== true) return e;
    if (before.indexOf(e.from) === -1) return e;      // 原文没出现 ⇒ 谈不上本词生效
    if (after.indexOf(e.to) === -1) return e;         // 结果没有目标写法 ⇒ 没改成
    if (after.indexOf(e.from) !== -1) return e;       // 原来的写法还在 ⇒ 只算部分/未改
    return { from: e.from, to: e.to, hits: (e.hits || 0) + 1, at: at, enabled: true };
  });
}

// 从「机器输出 → 用户手改」的差异里学一条候选：公共前后缀之外的那一段。
// 纯插入/纯删除（一侧为空）、超长、长度差 > 2 ⇒ 不入库（形近筛子）。
function learnVoiceDictionaryDiff(machine, edited) {
  const a = typeof machine === 'string' ? machine : '';
  const b = typeof edited === 'string' ? edited : '';
  if (!a || !b || a === b) return [];
  let p = 0;
  const maxP = Math.min(a.length, b.length);
  while (p < maxP && a.charAt(p) === b.charAt(p)) p += 1;
  let s = 0;
  const maxS = Math.min(a.length - p, b.length - p);
  while (s < maxS && a.charAt(a.length - 1 - s) === b.charAt(b.length - 1 - s)) s += 1;
  const from = a.slice(p, a.length - s);
  const to = b.slice(p, b.length - s);
  if (!from || !to) return [];
  if (from.trim() === '' || to.trim() === '') return [];
  // ⚠ 单字差异**不入库**：中文里一字之差往往是同音/近义误判（`置`↔`装`、`快`↔`慢`），
  //   自动学习收进来会变成噪声、且替换面极大（用户仍可**手动**新增单字条目 —— 那是明确意图）。
  if (from.length < 2 || to.length < 2) return [];
  if (from.length > VOICE_DICTIONARY_MAX_TERM || to.length > VOICE_DICTIONARY_MAX_TERM) return [];
  if (Math.abs(from.length - to.length) > 2) return [];
  return [{ from: from, to: to, hits: 1, at: Date.now(), enabled: true }];
}

module.exports = {
  VOICE_CONFIG_KEYS,
  VOICE_CONFIG_DEFAULTS,
  cloneVoiceConfigDefaults,
  normalizeVadSilenceMs,
  normalizeVadFloorDb,
  VOICE_ENHANCE_MODES,
  normalizeAutoEnhanceMode,
  normalizeCorrectionWindowRounds,
  VOICE_DICTIONARY_MAX_ENTRIES,
  VOICE_DICTIONARY_MAX_TERM,
  normalizeDictionaryEntries,
  matchVoiceDictionary,
  recordVoiceDictionaryHits,
  VOICE_DICTIONARY_PROMPT_MAX_HITS,
  learnVoiceDictionaryDiff,
};
