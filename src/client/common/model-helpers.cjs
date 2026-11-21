'use strict';

// 客户端模型纯函数（目标模式：普通 CommonJS，构建期由共享运行时内联）。
// ⚠ 归属纪律（2026-11-21 · issue #16）：模型相关的纯查表/排序归本模块，并由
//   `common/runtime.cjs` 再导出；⛔ 不得把它们塞进 `createClientHelpers` 的状态闭包——
//   装配层会把「纯契约」从 shared 取，取工厂产物只会得到 undefined（渲染期才炸）。
// 候选顺序 = order 中的显式位置优先，其次内置候选优先于自定义候选。

const MODEL_DISPLAY_NAMES = {
  'deepseek-v4-flash': 'DeepSeek-V4-Flash',
  'deepseek-v4-pro': 'DeepSeek-V4-Pro',
  'mimo-v2.5': 'MiMo-V2.5',
  'mimo-v2.5-pro': 'MiMo-V2.5-Pro',
  'qwen3.7-max': 'Qwen3.7-Max',
  'kimi-k2.7-code': 'Kimi-K2.7-Code',
};

/** 模型 id → 展示名；未登记的原样返回（纯函数：无状态、无宿主依赖）。 */
function prettifyModel(id) {
  return MODEL_DISPLAY_NAMES[id] || id;
}

function buildCandidates(providers, customModels, order) {
  const list = [];
  if (providers) {
    for (const p of providers) {
      for (const m of p.models || []) list.push({ provider: p.provider, model: m.id, name: m.name || m.id, custom: false });
    }
  }
  for (const c of customModels || []) list.push({ provider: c.provider, model: c.model, name: c.name || c.model, custom: true });
  const orderIndex = new Map();
  (order || []).forEach((k, i) => orderIndex.set(k, i));
  list.sort((a, b) => {
    const ia = orderIndex.has(a.provider + '/' + a.model) ? orderIndex.get(a.provider + '/' + a.model) : 1e9;
    const ib = orderIndex.has(b.provider + '/' + b.model) ? orderIndex.get(b.provider + '/' + b.model) : 1e9;
    if (ia !== ib) return ia - ib;
    return (a.custom ? 1 : 0) - (b.custom ? 1 : 0);
  });
  return list;
}

module.exports = { buildCandidates, prettifyModel };
