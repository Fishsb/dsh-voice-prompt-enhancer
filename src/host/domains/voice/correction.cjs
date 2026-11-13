'use strict';

// 语音纠错执行域（目标模式：普通 CommonJS，构建期由打包器内联）。
//
// 边界：
//   · 只负责 voice/correct 的一次执行（开关守卫、历史参考、模型链、结果清洗）；
//   · 宿主能力（llm / timer / sessionQuery / readVoiceConfig）全部经 deps 注入；
//   · 不注册 RPC、不读全局变量、不直接操作 pending/progress。
//
// 兼容性：返回值与既有 RPC 逐项一致，包括 skipped/skippedBy/switchFrom/code、
// changed、historyChars、fallbackUsed 与失败 code/message。
const { resolveCorrectionSwitch, CORRECTION_DISABLED_CODE, CORRECTION_ENABLED_REASON } = require('./switch.cjs');
// CHG-390（2026-11-13 · 词库改作纠错参考）：词库**不再**在 client 侧做字面硬替换，
//   改为在这里挑出「草稿中命中的词条」拼进纠错提示词的 {dictionary} 块，由模型结合上下文判断。
//   ⚠ 归一/筛子/上限一律取契约层（lib/voice-config.cjs，经 shared 转发）——⛔ 不在此重写第二份。
const { matchVoiceDictionary } = require('../../../shared/contracts/voice-config.cjs');

const CORRECTION_WINDOW = [1, 1];

// 纠错参考窗口：默认 [1,1]（最近 1 轮）。可经 voice.correction.windowRounds 配置为 1–3 轮。
// 非法/缺省 ⇒ 回落默认；只改「读多少轮」，⛔ 不改 UD-0051「必须有会话参考」这条。
function resolveCorrectionWindow(cfg) {
  const n = cfg && cfg.correction && cfg.correction.windowRounds;
  if (!Number.isInteger(n) || n < 1 || n > 3) return CORRECTION_WINDOW;
  return [1, n];
}
const CORRECTION_TIMEOUT_MS = 30000;
const CORRECTION_MAX_TOKENS = 4000;
const CORRECTION_OUTPUT_LIMIT = 16000;

// 把命中的词条渲染成提示词里的人类可读清单。
//   · 一行一条「识别成 → 应该改成」；空列表 ⇒ 空串（提示词内该小节据此判定"不适用"）。
//   · ⚠ 只呈现**词形对应**，不附带任何"应当替换"的指令性措辞——该不该改由模型按判据决定。
function renderDictionaryHits(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const lines = [];
  for (let i = 0; i < list.length; i += 1) {
    const e = list[i] && typeof list[i] === 'object' ? list[i] : null;
    if (!e) continue;
    const from = typeof e.from === 'string' ? e.from : '';
    const to = typeof e.to === 'string' ? e.to : '';
    if (!from || !to) continue;
    lines.push('- ' + from + ' → ' + to);
  }
  return lines.join('\n');
}

// 取本会话词库里「在草稿中命中」的条目。fail-closed：任一环缺位 ⇒ 空数组（等同于"无词库参考"）。
//   ⚠ 读取面复用 harness.readVoiceConfig()（= 已归一化的磁盘 voice 段，见 lib/harness.cjs）；
//     ⛔ 不经请求 args.config —— 请求里带的是**增强**配置，从来不含 voice.dictionary。
function resolveDictionaryHits(text, harness) {
  try {
    if (!text || typeof text !== 'string') return [];
    const face = (harness && typeof harness.readVoiceConfig === 'function') ? harness.readVoiceConfig() : null;
    if (!face || typeof face !== 'object') return [];
    const dict = face.dictionary && typeof face.dictionary === 'object' ? face.dictionary : null;
    if (!dict) return [];
    return matchVoiceDictionary(text, dict.entries);
  } catch (e) {
    return [];
  }
}

function createCorrectionRunner(deps) {
  const d = deps && typeof deps === 'object' ? deps : {};
  const ctx = d.ctx;
  const harness = d.harness;
  const llm = d.llm;
  const hlog = typeof d.hlog === 'function' ? d.hlog : () => {};
  const startWaitAbort = d.startWaitAbort;
  const validateConfig = d.validateConfig;
  const buildTryChain = d.buildTryChain;
  const collectStream = d.collectStream;
  const cleanCorrectionOutput = d.cleanCorrectionOutput;
  const friendlyMessage = d.friendlyMessage;
  const extractHistoryConclusions = d.extractHistoryConclusions;
  const splitHistoryRounds = d.splitHistoryRounds;
  const correctionPrompt = d.correctionPrompt;
  const historyTimeoutMs = d.historyTimeoutMs;

  async function fetchCorrectionHistory(sessionId, config) {
    const sq = ctx && typeof ctx.get === 'function' ? ctx.get('sessionQuery') : null;
    if (!sq || typeof sq.readSurface !== 'function') {
      hlog('[correction] history skipped no-readSurface');
      return '';
    }
    const waitAbort = startWaitAbort(ctx.timer, historyTimeoutMs);
    try {
      const surface = await waitAbort.race(sq.readSurface(sessionId));
      if (waitAbort.timedOut()) { hlog('[correction] history timeout'); return ''; }
      const events = extractHistoryConclusions(surface && surface.events);
      const win = resolveCorrectionWindow(config);
      const lines = splitHistoryRounds(events, win[0], win[1]);
      const text = lines.join('\n');
      hlog('[correction] history rounds=' + win[0] + '-' + win[1] + ' events=' + events.length + ' chars=' + text.length);
      return text;
    } catch (e) {
      hlog('[correction] history failed', e && e.message ? e.message : e);
      return '';
    } finally {
      waitAbort.dispose();
    }
  }

  async function runCorrection(args) {
    const sessionId = args && typeof args.sessionId === 'string' ? args.sessionId : 'unknown';
    const text = args && typeof args.text === 'string' ? args.text : '';
    if (text.trim() === '') return { ok: false, code: 'GUARD', message: friendlyMessage({ code: 'GUARD' }) };

    if (llm === undefined) return { ok: false, code: 'NO_LLM', message: friendlyMessage({ code: 'NO_LLM' }) };
    const cfg = validateConfig(args && args.config);
    // 宿主 harness 缺 readVoiceConfig（旧夹具/非 bundle 载体）时，按既有语义回退请求配置；
    // 产品链路始终由 harness.readVoiceConfig() 提供归一化面。
    const corrSwitch = resolveCorrectionSwitch(args && args.config, harness && typeof harness.readVoiceConfig === 'function' ? harness : null);
    if (corrSwitch.on !== true) {
      hlog('[correction] skipped session=' + sessionId + ' from=' + corrSwitch.from);
      return {
        ok: true,
        skipped: true,
        skippedBy: CORRECTION_ENABLED_REASON,
        switchFrom: corrSwitch.from,
        code: CORRECTION_DISABLED_CODE,
        text,
        message: friendlyMessage({ code: CORRECTION_DISABLED_CODE }),
      };
    }
    const chain = buildTryChain(cfg.fallback);
    if (chain.length === 0) return { ok: false, code: 'NO_MODEL', message: friendlyMessage({ code: 'NO_MODEL' }) };
    const historyText = await fetchCorrectionHistory(sessionId, args && args.config);
    // CHG-390：词库命中参考（只喂进提示词，⛔ 不预替换草稿）
    const dictHits = resolveDictionaryHits(text, harness);
    const dictionaryText = renderDictionaryHits(dictHits);
    // ⚠ 先替换 {dictionary} 再替换 {history}：历史文本里若恰好出现字面 "{dictionary}"
    //   不会被二次展开（顺序固定 = 可复现）。
    const system = correctionPrompt
      .replace('{dictionary}', dictionaryText)
      .replace('{history}', historyText);
    let lastFailure = null;
    for (let i = 0; i < chain.length; i++) {
      const entry = chain[i];
      let timedOut = false;
      let abortIterator = null;
      let settleTimeout = null;
      const gate = new Promise((resolve) => { settleTimeout = resolve; });
      const fireAbort = () => {
        timedOut = true;
        if (abortIterator && typeof abortIterator.return === 'function') {
          try { abortIterator.return(); } catch (e) { /* 忽略 */ }
        }
        try { settleTimeout({ kind: 'aborted', aborted: true }); } catch (e) { /* 忽略 */ }
      };
      const timer = ctx.timer.timeout(fireAbort, CORRECTION_TIMEOUT_MS);
      try {
        hlog('[correction] try session=' + sessionId + ' provider=' + entry.provider + ' model=' + entry.model);
        const stream = llm.stream({
          provider: entry.provider,
          model: entry.model,
          maxTokens: CORRECTION_MAX_TOKENS,
          temperature: 0.3,
          system,
          messages: [{
            id: 'correction-' + sessionId,
            role: 'user',
            content: [{ type: 'text', text }],
            source: { kind: 'user' },
          }],
        });
        const iterator = stream[Symbol.asyncIterator]();
        abortIterator = iterator;
        const collectP = collectStream(iterator, CORRECTION_OUTPUT_LIMIT);
        collectP.catch(() => { /* 落败方 */ });
        const result = await Promise.race([collectP, gate]);
        if (!timedOut && result.kind === 'ok') {
          const out = cleanCorrectionOutput(result.text, text);
          if (typeof out === 'string' && out.trim() !== '') {
            hlog('[correction] ok session=' + sessionId + ' chars=' + out.length + ' history=' + historyText.length + ' dictHits=' + dictHits.length);
            const changedFlag = out !== text;
            // CHG-390：把本次**进过提示词**的词库条目编号/原文回传，client 侧据此判定
            //   「哪些词条真的被改对了」并累加 hits（判据在契约层 recordVoiceDictionaryHits，纯字面）。
            //   ⚠ 只在有命中时附字段 ⇒ 无词库时返回值与既有逐字段一致（不新增噪声）。
            const dictField = dictHits.length > 0
              ? { dictionaryHits: dictHits.map((e) => ({ from: e.from, to: e.to })) }
              : null;
            return Object.assign(
              { ok: true, text: out, provider: entry.provider, model: entry.model, historyChars: historyText.length, changed: changedFlag, fallbackUsed: i > 0 },
              dictField || {},
            );
          }
          lastFailure = { code: 'EMPTY_RESPONSE' };
        } else {
          lastFailure = timedOut ? { code: 'TIMEOUT' }
            : (result.kind === 'maxtokens' ? { code: 'OUTPUT_TRUNCATED' }
            : (result.failure || { code: 'EMPTY_RESPONSE' }));
        }
      } catch (e) {
        lastFailure = { code: e && e.code ? String(e.code) : 'STREAM_THROW', message: String(e && e.message ? e.message : e) };
        hlog('[correction] stream failed code=' + lastFailure.code);
      } finally {
        try { timer(); } catch (e) { /* 忽略 */ }
        if (abortIterator && typeof abortIterator.return === 'function') {
          try { abortIterator.return(); } catch (e) { /* 忽略 */ }
        }
      }
      const code = lastFailure ? lastFailure.code : 'UNKNOWN';
      if (code === 'TIMEOUT' || code === 'ABORTED' || code === 'OUTPUT_TRUNCATED') break;
    }
    const code = lastFailure && lastFailure.code ? lastFailure.code : 'LLM_FAILED';
    hlog('[correction] failed session=' + sessionId + ' code=' + code);
    return { ok: false, code, message: friendlyMessage({ code }) };
  }

  return { runCorrection, fetchCorrectionHistory };
}

module.exports = {
  CORRECTION_WINDOW,
  resolveCorrectionWindow,
  CORRECTION_TIMEOUT_MS,
  CORRECTION_MAX_TOKENS,
  CORRECTION_OUTPUT_LIMIT,
  createCorrectionRunner,
};