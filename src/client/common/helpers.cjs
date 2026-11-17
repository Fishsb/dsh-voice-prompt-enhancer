'use strict';

// 客户端增强会话模块（普通 CommonJS，构建期由共享运行时内联）。
// 环境能力均由 createClientHelpers 显式注入；组件仍消费同名函数，用户可见契约不变。
const {
  MEMORY_ROUNDS_MAX,
  SEEN_KEY_PREFIX,
  MODE_VALUES,
} = require('./constants.cjs');
const { RPC_METHODS } = require('../../shared/contracts/rpc.cjs');

const { errorKeyOf: contractErrorKey } = require('../../shared/contracts/errors.cjs');

const MODEL_DISPLAY_NAMES = {
  'deepseek-v4-flash': 'DeepSeek-V4-Flash',
  'deepseek-v4-pro': 'DeepSeek-V4-Pro',
  'mimo-v2.5': 'MiMo-V2.5',
  'mimo-v2.5-pro': 'MiMo-V2.5-Pro',
  'qwen3.7-max': 'Qwen3.7-Max',
  'kimi-k2.7-code': 'Kimi-K2.7-Code',
};

function createClientHelpers(deps) {
  const d = deps && typeof deps === 'object' ? deps : {};
  const host = d.host;
  const configState = d.configState;
  const dictionary = d.dictionary && typeof d.dictionary === 'object' ? d.dictionary : {};
  const resultStatusOf = typeof d.resultStatusOf === 'function'
    ? d.resultStatusOf
    : (result) => (result && result.ok === true ? 'changed' : 'failed');
  const storage = d.storage || (typeof localStorage !== 'undefined' ? localStorage : null);

  let dshEnhIdSeq = 0;

  // 稳定 id 用于 label htmlFor / aria-controls / aria-describedby；
  // 组件以 useState(() => ...) / useRef 固定一次，避免重渲染漂移。
  function dshEnhId(prefix) {
    dshEnhIdSeq += 1;
    return (prefix || 'dsh-enh') + '-' + dshEnhIdSeq;
  }

  function errorKey(code) {
    return contractErrorKey(code);
  }

  function makeT(props) {
    if (props && typeof props.t === 'function') return props.t;
    return (key) => dictionary[key] || key;
  }

  const sessionStores = new Map();
  // PE-21（2026-11-17）：会话级记忆链**带外**存储（store 卸载时迁移到这里，重建时取回）。
  const memoryCarry = new Map();
  let activeSessionId = null;

  function resultKey(sessionId) {
    return 'dsh-enh-result:' + sessionId;
  }

  function readStoredResult(sessionId) {
    if (!storage || typeof storage.getItem !== 'function') return null;
    try {
      const raw = storage.getItem(resultKey(sessionId));
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.b === 'string' && typeof parsed.e === 'string' && parsed.e !== '') {
        return parsed;
      }
    } catch (error) { /* 持久化恢复失败时按空闲态启动 */ }
    return null;
  }

  function storeFor(sessionId) {
    let session = sessionStores.get(sessionId);
    if (session) return session;

    session = {
      phase: 'idle',
      backup: '',
      enhanced: '',
      error: null,
      seq: 0,
      listeners: new Set(),
      // PE-21（2026-11-17）：store 重建时取回带外记忆链（卸载时迁走的那些）。
      memoryRounds: memoryCarry.has(sessionId) ? memoryCarry.get(sessionId).slice() : [],
      optimized: false,
      lastModel: '',
      fallbackUsed: false,
      degraded: [],
      truncated: false,
    };

    // 整页刷新后恢复尚未消费的增强结果。
    const restored = readStoredResult(sessionId);
    if (restored) {
      session.phase = 'result';
      session.backup = restored.b;
      session.enhanced = restored.e;
      session.optimized = true;
    }
    sessionStores.set(sessionId, session);
    return session;
  }

  function seenKey(sessionId) {
    return SEEN_KEY_PREFIX + sessionId;
  }

  function writeSeen(sessionId) {
    if (!storage || typeof storage.setItem !== 'function') return;
    try { storage.setItem(seenKey(sessionId), '1'); } catch (error) { /* 标记写入失败不阻断增强 */ }
  }

  function clearSeen(sessionId) {
    if (!storage || typeof storage.removeItem !== 'function') return;
    try { storage.removeItem(seenKey(sessionId)); } catch (error) { /* 标记清理失败不阻断发送 */ }
  }

  function subscribe(sessionId, listener) {
    const session = storeFor(sessionId);
    session.listeners.add(listener);
    return () => { session.listeners.delete(listener); };
  }

  function notify(sessionId) {
    const session = storeFor(sessionId);
    for (const listener of [...session.listeners]) listener();
  }

  function setActiveSession(sessionId) {
    activeSessionId = sessionId || null;
  }

  function getActiveSession() {
    return activeSessionId;
  }

  function saveResultStore(sessionId, backup, enhanced) {
    if (!storage || typeof storage.setItem !== 'function') return;
    try {
      storage.setItem(resultKey(sessionId), JSON.stringify({ b: backup, e: enhanced }));
    } catch (error) { /* 结果持久化失败不阻断写回 */ }
  }

  function clearResultStore(sessionId) {
    if (!storage || typeof storage.removeItem !== 'function') return;
    try { storage.removeItem(resultKey(sessionId)); } catch (error) { /* 结果清理失败不阻断状态复位 */ }
  }

  function isEnhancing(sessionId) {
    const session = sessionStores.get(sessionId);
    return !!(session && session.phase === 'enhancing');
  }

  // ⚠⚠ PE-21 修复（2026-11-17 · 全功能审查 medium）：**记忆链不得随 store 卸载丢失**。
  //   病历：草稿被外部改写会把 phase 复位为 idle（`button.cjs` 的同步 effect），
  //     随后 `releaseStoreIfIdle` 把**整条 store**删掉 ⇒ `memoryRounds` 一并蒸发。
  //     实测 rounds 1 → 0，而 i18n 明文承诺「发送消息会清空记忆链」——不是卸载时清。
  //   修法：卸载前把 `memoryRounds` 迁到**会话级独立 Map**（key = sessionId），
  //     下次 `storeFor` 重建时取回。⛔ 不清空：清空只发生在「发送消息」路径（既有行为）。
  function releaseStoreIfIdle(sessionId) {
    const session = sessionStores.get(sessionId);
    if (!session) return;
    if (session.phase === 'idle' && session.listeners.size === 0 && session.error === null) {
      if (Array.isArray(session.memoryRounds) && session.memoryRounds.length > 0) {
        memoryCarry.set(sessionId, session.memoryRounds.slice());
      }
      sessionStores.delete(sessionId);
    }
  }

  // ⚠⚠ PE-21 补修（2026-11-17 · 本轮体检 F05-1/F05-2，两条 medium）：
  //   **「发送消息清空记忆链」必须同时清掉带外副本，否则清空会被卸载再挂载复活。**
  //   病历：首版只在 releaseStoreIfIdle 里把 rounds 写进 memoryCarry、永不 delete；
  //     而发送清空只置 `store.memoryRounds = []`（重建后的那个新数组）⇒
  //     实测 A5：发送清空 → 卸载 → 再挂载 ⇒ 记忆链**又变回 1 轮**（期望 0）。
  //   后果有两层：① 用户以为清空了，实际下一轮请求又把旧轮次发给 host；
  //     ② memoryCarry 只增不减 ⇒ 长会话页面内存无上界（每会话最多 4 轮全文）。
  //   修法：提供 clearMemoryChain(sessionId)，**同时**清 store 与 carry —— 单一入口，语义唯一。
  function clearMemoryChain(sessionId) {
    memoryCarry.delete(sessionId);
    const session = sessionStores.get(sessionId);
    if (session) {
      session.memoryRounds = [];
      session.memoryRoundPushed = false;
      session.optimized = false;
    }
  }

  function safeSetDraft(inputActions, text) {
    if (!inputActions || typeof inputActions.setDraft !== 'function') return;
    try { inputActions.setDraft(text); } catch (error) { /* 输入框卸载竞态不阻断状态复位 */ }
  }

  function cancelEnhance(sessionId, inputActions) {
    const session = storeFor(sessionId);
    if (session.phase !== 'enhancing') return;
    const seq = session.seq;
    session.seq += 1;
    clearResultStore(sessionId);
    safeSetDraft(inputActions, session.backup);
    session.phase = 'idle';
    session.enhanced = '';
    session.error = null;
    clearResultStore(sessionId);
    notify(sessionId);
    host.call(RPC_METHODS.CANCEL, { sessionId, seq }).catch(() => {});
  }

  // 斜杠命令只优化正文，原命令与空白前缀保持不变。
  function splitCommand(draft) {
    const match = /^(\/\S+)(\s+)([\s\S]*)$/.exec(draft);
    if (match) return { prefix: match[1] + match[2], body: match[3] };
    return { prefix: '', body: draft };
  }

  // 记忆只携带历史轮次，不改变用户选择的模式。
  function resolveActualMode(sessionId, cfg) {
    const session = storeFor(sessionId);
    const mode = cfg.mode;
    const seed = false;
    let memory = null;
    if (cfg.memory && session.memoryRounds && session.memoryRounds.length > 0) {
      memory = { rounds: session.memoryRounds };
    }
    return { mode, seed, memory };
  }

  function prettifyModel(id) {
    return MODEL_DISPLAY_NAMES[id] || id;
  }

  // UD-0052（2026-11-08 · 语音四件收口批）：第 5 个可选入参 `modeOverride` = 本次增强的档位覆盖。
  //   ⚠ **只改 `mode` 一处**：`config` 原样传（构造 config 副本会连带改掉预算/超时/模板）。
  //   ⚠ 手动 ✨ 增强不传该参 ⇒ 行为逐字不变（仍取 `resolveActualMode` 的结果）。
  function enhance(sessionId, draft, inputActions, draftRef, modeOverride) {
    const session = storeFor(sessionId);
    if (session.phase === 'enhancing') {
      const previousSeq = session.seq;
      session.seq += 1;
      host.call(RPC_METHODS.CANCEL, { sessionId, seq: previousSeq }).catch(() => {});
    }

    // ⚠⚠ PE-22 补修（2026-11-17 · 本轮体检 F05-3）：**标记必须在新一轮起点复位**。
    //   病历：首版只在 push 处置 true、只在 undo pop 后置 false ⇒ 若用户「增强后改草稿（不走 undo）」
    //     再关记忆增强一次，标记仍是 true ⇒ 点撤销会把**上一轮**的记忆弹掉（原缺陷在另一条路径复发）。
    //   修法：每次 enhance 起点清零 —— 标记的语义是「**本轮**是否入队」，必须逐轮重置。
    session.memoryRoundPushed = false;
    session.backup = draft;
    session.seq += 1;
    const seq = session.seq;
    session.phase = 'enhancing';
    clearResultStore(sessionId);
    session.enhanced = '';
    session.error = null;
    notify(sessionId);

    const parts = splitCommand(draft);
    const config = configState.value;
    const actual = resolveActualMode(sessionId, config);
    const mode = (typeof modeOverride === 'string' && MODE_VALUES.includes(modeOverride)) ? modeOverride : actual.mode;
    const request = { sessionId, seq, text: parts.body, config, mode };
    if (actual.seed) request.seed = true;
    if (actual.memory) request.memory = actual.memory;
    if (session.optimized && actual.memory && actual.memory.rounds.length > 0) request.continue = true;

    host.call(RPC_METHODS.ENHANCE, request).then((response) => {
      if (seq !== session.seq) return;
      const result = response && typeof response === 'object' ? response : {};
      const resultStatus = resultStatusOf({ ok: result.ok === true, text: result.text, before: session.backup, skipped: result.skipped === true });

      if (result.ok && typeof result.text === 'string' && result.text !== '') {
        const sessionChanged = getActiveSession() !== sessionId;
        if (!sessionChanged && draftRef.current !== session.backup) {
          // 增强期间用户已编辑草稿：迟到结果丢弃，不写记忆、不打优化标记。
          session.phase = 'idle';
          session.enhanced = '';
          session.error = null;
          clearResultStore(sessionId);
        } else {
          const finalText = parts.prefix + result.text;
          if (!sessionChanged) safeSetDraft(inputActions, finalText);
          saveResultStore(sessionId, session.backup, finalText);
          session.phase = 'result';
          session.enhanced = finalText;
          session.error = null;
          session.optimized = true;
          session.lastModel = result.model || '';
          session.fallbackUsed = result.fallbackUsed === true;
          session.degraded = Array.isArray(result.degraded) ? result.degraded.slice(0, 12) : [];
          session.truncated = result.truncated === true;
          session.resultStatus = resultStatus;

          if (config.memory) {
            session.memoryRounds.push({ input: parts.body, output: result.text });
            // PE-22（2026-11-17）：标记「本轮入过队」，供 undo 判断该不该 pop。
            session.memoryRoundPushed = true;
            if (session.memoryRounds.length > MEMORY_ROUNDS_MAX) session.memoryRounds.shift();
            writeSeen(sessionId);
          }
        }
      } else {
        safeSetDraft(inputActions, session.backup);
        session.phase = 'idle';
        session.enhanced = '';
        session.error = result.code && errorKey(result.code) !== 'errUNKNOWN' ? result.code : 'UNKNOWN';
        clearResultStore(sessionId);
      }
      notify(sessionId);
    }).catch(() => {
      if (seq !== session.seq) return;
      safeSetDraft(inputActions, session.backup);
      session.phase = 'idle';
      session.enhanced = '';
      session.error = 'NETWORK';
      clearResultStore(sessionId);
      notify(sessionId);
    });
  }

  function undo(sessionId, inputActions) {
    const session = storeFor(sessionId);
    if (session.phase !== 'result') return;
    safeSetDraft(inputActions, session.backup);
    session.phase = 'idle';
    session.enhanced = '';
    session.error = null;
    session.degraded = [];
    session.truncated = false;
    // ⚠⚠ PE-22 修复（2026-11-17 · 全功能审查 medium）：**不得无条件 pop**。
    //   病历：`pop()` 不看本轮是否入队，而 push 只在 `if (config.memory)` 分支发生
    //     ⇒ 关记忆那一轮撤销会弹掉**上一轮**的记录（实测：memory ON 得 ["first"]，
    //     memory OFF 再增强后撤销 ⇒ "first" 被删）。
    //   修法：本轮确实入过队才弹（用 store 上的标记判断，标记在 push 处设置）。
    if (session.memoryRoundPushed) {
      session.memoryRounds.pop();
      session.memoryRoundPushed = false;
    }
    session.optimized = false;
    clearResultStore(sessionId);
    notify(sessionId);
  }

  function guardPasses(draft, input) {
    if (typeof draft !== 'string') return false;
    const normalized = draft.trim();
    if (normalized === '') return false;
    if (normalized.startsWith('/') && !/^\/\S+\s+\S+/.test(normalized)) return false;
    if (!input) return false;
    if (input.phase === 'adjudicating' || input.phase === 'submitting') return false;
    return true;
  }

  return {
    dshEnhId,
    errorKey,
    makeT,
    sessionStores,
    storeFor,
    seenKey,
    writeSeen,
    clearSeen,
    subscribe,
    notify,
    setActiveSession,
    getActiveSession,
    resultKey,
    saveResultStore,
    clearResultStore,
    isEnhancing,
    releaseStoreIfIdle,
    clearMemoryChain,
    safeSetDraft,
    cancelEnhance,
    splitCommand,
    resolveActualMode,
    prettifyModel,
    enhance,
    undo,
    guardPasses,
  };
}

module.exports = { createClientHelpers };
