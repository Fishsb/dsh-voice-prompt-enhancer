'use strict';

const { RPC_METHODS } = require('../../../shared/contracts/rpc.cjs');

// 设置页模型配置组件普通模块（构建期由客户端运行时内联）。
// 迁移只改变代码载体；组件行为、文案、类名与 ARIA 不变。
function createFallbackRow(deps) {
  const d = deps && typeof deps === 'object' ? deps : {};
  const React = d.React;
  const MarqueeSelect = d.MarqueeSelect;
  const makeT = d.makeT;
  const host = d.host;
function FallbackRow(props) {
  const t = makeT(props);
  const entry = props.entry;
  const index = props.index;
  const count = props.count;
  const providers = props.providers;       // [{provider, name, models:[{id,name}]}]
  const candidates = props.candidates;     // 跨厂家候选（含自定义，兼容存量）
  const testing = props.testing;           // 本行是否测试中（父级单点状态）
  const invalid = props.invalid;           // F1：本行是否失效（不在候选列表中）
  const onChange = props.onChange;
  const onMove = props.onMove;
  const onRemove = props.onRemove;
  const onTest = props.onTest;
  const [reasoning, setReasoning] = React.useState(null);

  React.useEffect(() => {
    setReasoning(null);
    if (!entry.provider || !entry.model) return;
    let cancelled = false;
    // F1（配置卫生）：已启用思考的条目用 noCache 取新鲜能力表，用于 effort 纠偏
    const needFresh = !!(entry.reasoning && entry.reasoning.enabled === true);
    host.call(RPC_METHODS.MODELS_RESOLVE, { provider: entry.provider, model: entry.model, ...(needFresh ? { noCache: true } : {}) }).then((res) => {
      if (cancelled) return;
      const r = res && typeof res === 'object' ? res : {};
      const meta = r.ok && r.reasoning && r.reasoning.efforts && r.reasoning.efforts.length > 0 ? r.reasoning : null;
      if (meta) setReasoning(meta);
      // F1（配置卫生）：effort 自动纠偏——存储 effort 不在模型能力列表 → 修正为默认等级；
      // 模型不支持思考但存储仍启用 → 移除 reasoning（防止失效 effort 随请求发送给 LLM）
      if (r.ok && entry.reasoning && entry.reasoning.enabled === true) {
        if (meta) {
          const valid = meta.efforts.some((e) => String(e.id) === entry.reasoning.effort);
          if (!valid) onChange({ ...entry, reasoning: { enabled: true, effort: String(meta.defaultEffort || meta.efforts[0].id) } });
        } else {
          const fix = { ...entry };
          delete fix.reasoning;
          onChange(fix);
        }
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [entry.provider, entry.model]);

  // 2026-11-14（开关并入档位批 · 用户裁定）：不再有独立的「开/关」下拉 —— 「Off」本身就是模型能力表里的
  //   **一个档位**（用户原话：「图片的 off 不就是关闭吗」）⇒ 档位下拉直接列出 efforts 全量（含 Off）。
  //   ⚠ 单一事实源不变：关闭状态仍 = entry 里**没有 reasoning 字段**（F7 语义），不是 { enabled:false }。
  //   ⚠ 'off' 作为 effort 值出现在存量配置里时（旧版曾写 enabled:true, effort:'off'）同样按关闭呈现——
  //     否则会渲染出一个「开着但档位是 Off」的自相矛盾态。
  const OFF_EFFORT = 'off';
  const storedEffort = entry.reasoning && typeof entry.reasoning.effort === 'string' ? entry.reasoning.effort : '';
  const effortOn = !!(entry.reasoning && entry.reasoning.enabled) && storedEffort !== OFF_EFFORT;
  const levelOptions = reasoning ? reasoning.efforts.map((e) => React.createElement('option', { key: e.id, value: e.id }, e.name)) : [];
  // ⚠⚠ PE-34 修复（2026-11-17 · 全功能审查 medium）：**关闭态不得显示成具体档位**。
  //   病历：能力表若没有 `off` 条目（个别模型），原实现回落到 `defaultEffort` / 首个档位
  //     ⇒ 界面显示「High」而配置里**没有 reasoning 字段**（= 关闭）⇒ **显示与实况相反**。
  //   修法：没有 `off` 条目时，**插入一个合成的「关」选项**并选中它（值仍是 `off`），
  //     这样「显示 = 配置」恒成立，且用户仍能选到其它档位。
  const hasOffOption = !!(reasoning && reasoning.efforts.some((e) => String(e.id) === OFF_EFFORT));
  const levelValue = effortOn ? storedEffort : OFF_EFFORT;
  const levelOptionsFinal = (function () {
    if (!reasoning) return [];
    const base = reasoning.efforts.map((e) => React.createElement('option', { key: e.id, value: e.id }, e.name));
    // PE-34：能力表缺 off ⇒ 补一个合成项（否则选中值在列表里找不到，浏览器会显示第一项）
    if (!hasOffOption) base.unshift(React.createElement('option', { key: OFF_EFFORT, value: OFF_EFFORT }, t('cfgReasoningOff')));
    return base;
  })();

  // v22（C4）/v23：按厂家区分——厂家下拉选项 = providers；模型下拉 = 当前厂家模型 + 该厂家自定义候选
  const currentProvider = providers && providers.find((p) => p.provider === entry.provider);
  const modelOptions = (currentProvider ? currentProvider.models || [] : [])
    .concat(candidates ? candidates.filter((c) => c.custom && c.provider === entry.provider).map((c) => ({ id: c.model, name: c.name })) : []);
  const onProviderChange = (e) => {
    const provider = e.target.value;
    const p = providers && providers.find((x) => x.provider === provider);
    const first = p && p.models && p.models[0] ? p.models[0].id : '';
    // F1（配置卫生）：切换厂家/模型保留 reasoning（不硬重置）——新模型能力纠偏由 resolve effect 接管
    onChange({ ...entry, provider, model: first });
  };

  return React.createElement('div', { className: 'dsh-plg-row' },
    React.createElement('span', { className: 'dsh-plg-muted dsh-plg-num' }, String(index + 1)),
    // 2026-10-19（清债批 D-2）：原 'dsh-plg-badge-invalid' 是**孤儿类**（styles.js 解码全文零规则，
    //   且无 querySelector 依赖）⇒ 该类名不承担任何视觉表达；『当前不可用』的可见标识由本节点自身承载：
    //   ① 内容字形 '⚠' ② title=cfgRowInvalid（悬停/读屏可读）③ 既有类 dsh-plg-upd-outdated 的告警色。
    //   ⛔ 不得删除本节点本身 —— 那会让『无效』变得不可见（产品语义）。
    invalid ? React.createElement('span', { className: 'dsh-plg-upd-outdated', title: t('cfgRowInvalid') }, '⚠') : null,
    React.createElement(MarqueeSelect, {
      className: 'dsh-plg-select dsh-plg-select-provider',
      value: entry.provider || '',
      onChange: onProviderChange,
      children: (providers || []).map((p) => React.createElement('option', { key: p.provider, value: p.provider }, p.name || p.provider)),
    }),
    // 2026-10-18（最小改动批 · 模型名截断）：窄行里模型名会被 mselect 的 ellipsis 裁掉，
    //   用户无法确认选的是哪个模型 ⇒ 用 title 承载**完整名**（悬停可见）。
    //   ⚠ 只加 title：不改名称、不改宽度、不改整行分配。
    React.createElement(MarqueeSelect, {
      className: 'dsh-plg-select dsh-plg-select-model',
      value: entry.model || '',
      title: (function () {
        var hit = modelOptions.filter(function (mm) { return mm.id === entry.model; })[0];
        return hit ? (hit.name || hit.id) : (entry.model || '');
      })(),
      onChange: (e) => onChange({ ...entry, model: e.target.value }),
      children: modelOptions.map((m) => React.createElement('option', { key: m.id, value: m.id }, m.name || m.id)),
    }),
    // 2026-11-14（开关并入档位批）：**一个**下拉承载完整状态 —— 档位列表里的 Off 即「关闭」。
    //   选 Off ⇒ 删除 reasoning 字段（F7 语义不变，host 零改动）；选其它档 ⇒ { enabled:true, effort }。
    //   ⚠ title 沿用原「思考开关」提示键（selThinking），文案值未改。
    reasoning
      ? React.createElement(MarqueeSelect, {
          className: 'dsh-plg-select dsh-plg-select-reason',
          title: t('selThinking'),
          value: levelValue,
          onChange: (e) => {
            const next = e.target.value;
            if (next === OFF_EFFORT) { const fix = { ...entry }; delete fix.reasoning; onChange(fix); }
            else onChange({ ...entry, reasoning: { enabled: true, effort: next } });
          },
          children: levelOptionsFinal,
        })
      : null,
    // v23（D4）：测试触发图标（结果由父级集中显示）
    React.createElement('button', {
      type: 'button',
      className: 'dsh-plg-btn dsh-plg-btn-icononly dsh-plg-testicon',
      disabled: testing || !entry.provider || !entry.model,
      onClick: onTest,
      title: t('cfgTest'),
      'aria-label': t('cfgTest'),
    }, testing ? '…' : '⛓'),
    React.createElement('button', { type: 'button', className: 'dsh-plg-btn dsh-plg-btn-icononly', disabled: index === 0, onClick: () => onMove(-1), title: t('rowUp'), 'aria-label': t('rowUp') }, '↑'),
    React.createElement('button', { type: 'button', className: 'dsh-plg-btn dsh-plg-btn-icononly', disabled: index === count - 1, onClick: () => onMove(1), title: t('rowDown'), 'aria-label': t('rowDown') }, '↓'),
    React.createElement('button', { type: 'button', className: 'dsh-plg-btn dsh-plg-btn-icononly', onClick: onRemove, title: t('rowRemove'), 'aria-label': t('rowRemove') }, '✕'),
  );
}
// 模型配置 tab（v18：helpers + fresh install 继承 + 四区块）
// @dsh-client-model-helpers-inject


  return FallbackRow;
}

module.exports = { createFallbackRow };
