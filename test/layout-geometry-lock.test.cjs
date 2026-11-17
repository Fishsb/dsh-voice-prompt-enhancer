'use strict';
// layout-geometry-lock.test —— 设置页**布局成因**的长期回归锁。
//
// ⚠ 为什么用**纯源码/结构判据**而不是量测：
//   · 本仓的量测装置（scripts/settings-layout-audit.mjs）需要 Chrome headless，
//     **在 CI / 干净 clone 上不保证可用** ⇒ 若把回归锁写成"必须跑浏览器"，
//     它会在 CI 上长期 SKIP，等于没有锁（本仓已有此类教训：判据面没有触发点 = 甲类）。
//   · 因此这里锁**布局的成因结构**（谁是不是 flex/grid 容器 / 宽度由谁决定 / 谁与谁同构），
//     它们**不需要浏览器**，且正是"修一边坏一边"发生的地方。
//   · 几何量测仍由 scripts/settings-layout-audit.mjs 承担（人工/部署前预检），两者互补。
//
// ⭐ 2026-11-13（设置面板排版批 · 方案 H）：本文件**整组重写**。
//   病历：旧锁逐条钉死的是「首行 flex + 四个 ToggleChip 固定宽契约 + 静音行滑块读数槽」——
//   那套结构已被用户裁定的新方案整体替换（开关并入下拉；静音滑块改档位下拉；
//   环境噪声与热键同构；状态四行收成一行；词典改双集合）。
//   ⇒ 旧断言全部失去判据对象（读到空段即红）。重写时**锁的意图不变**：
//     把「每一项设置怎么排」与「两行为什么能严格对齐」逐条钉死，并保留变异自证。
//   ⚠ 强度只升不降：新增「行标签列固定 / 控件列弹性」「噪声行与热键行同构」「词典双集合」
//     三类成因判据；旧锁里仍成立的两条（卡片边界 / tab 归属）原样保留。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { decodeChunk } = require('../scripts/lib/chunk-decode.mjs');
const voiceModules = require('./helpers/client-voice-modules.cjs');
const { ZH, EN } = require('./helpers/client-i18n.cjs');
const { stylesBody } = require('./helpers/client-styles.cjs');

function voiceSrc() {
  return voiceModules.voiceSectionSource();
}
function styleSrc() {
  return stylesBody();
}

// 取某段源码（用起止锚点切），供"只在某块内判"这类**范围限定**判据使用。
//   ⚠ 范围限定是必须的：本仓已实测"全文 grep 会命中别的选择器"给出假阳性 1。
function sliceBetween(src, startAnchor, endAnchor) {
  const i = src.indexOf(startAnchor);
  assert.ok(i >= 0, '前置：须能定位 ' + startAnchor);
  const j = src.indexOf(endAnchor, i);
  assert.ok(j > i, '前置：须能定位 ' + endAnchor);
  return src.slice(i, j);
}

// ───────── 2026-11-13（方案 H）：开关并入下拉 ─────────

test('GEOLOCK-01 四个设置项 = 四个「关 + 档位」合一下拉（⛔ 不得退回独立开关按钮）', () => {
  const s = voiceSrc();
  // ① 四个下拉必须都在（按 id 定位，⛔ 不按位置）
  for (const id of ['dsh-vi-auto-enhance', 'dsh-vi-correction', 'dsh-vi-filler', 'dsh-vi-vad']) {
    assert.ok(s.includes("'" + id + "'"), '缺设置项下拉：' + id);
  }
  // ② 每个下拉的首项必须是「关」（= 停用），且是**值 'off'**（⛔ 不是文本碰巧等于关）
  assert.equal((s.match(/\{ value: 'off', text: OFF_TEXT \}/g) || []).length, 4,
    '四个下拉的首项须都是 { value: \'off\', text: OFF_TEXT }（关 = 停用）');
  // ③ ⛔ 不得退回独立开关按钮（ToggleChip 是上一套结构的名词）
  assert.equal(/ToggleChip/.test(s), false, '⛔ 不得再出现 ToggleChip（开关已并入下拉）');
  assert.equal(/dsh-plg-tgl/.test(s), false, '⛔ 不得再渲染 dsh-plg-tgl 按钮（那会让「开关」与「档位」重新分家）');
});

test('GEOLOCK-02 档位文案不带「开 ·」前缀（有档位本身就是开启）', () => {
  const s = voiceSrc();
  // 用户逐字：「开·跟随全局，这种只需要显示跟随全局就可以了，有档位就是开启状态不需要多余标一个开」
  //   判据：档位 option 的 text 不得由「开」类键拼接 —— 逐个候选声明行断言。
  //   ⚠ 旧写法把切片起点写成 autoEnhanceOptions、终点 OFF_TEXT —— 两者顺序是反的（OFF_TEXT 在前），
  //     indexOf 取到 -1 ⇒ 断言读到空段而报红。现按各自的候选声明行逐个切片。
  const optStmt = (name) => {
    const i = s.indexOf('const ' + name + ' =');
    assert.ok(i >= 0, '前置：须能定位 ' + name);
    const j = s.indexOf(String.fromCharCode(59, 10), i);
    assert.ok(j > i, '前置：须能定位 ' + name + ' 的语句结尾');
    return s.slice(i, j + 1);
  };
  // ① 三个带档位的下拉：候选文案不得拼开/关（那正是用户点名要删的前缀）
  for (const name of ['autoEnhanceOptions', 'correctionOptions', 'vadOptions']) {
    assert.equal(/voiceAutoEnhanceOn|voiceAutoEnhanceOff/.test(optStmt(name)), false,
      '⛔ ' + name + ' 的候选文案不得拼开/关（有档位本身就是开启）');
  }
  // ② 清口水词是纯布尔项（无档位）⇒ 值文本取现有「开」键，这是唯一允许出现的地方
  assert.ok(optStmt('fillerOptions').includes("t('voiceAutoEnhanceOn')"),
    '清口水词下拉须有「开」这个值（纯布尔项，无档位可省前缀）');
});
test('GEOLOCK-03 行结构 = 固定宽标签列 + 弹性控件列（这是六行能上下对齐的成因）', () => {
  const s = voiceSrc();
  // ① 唯一的行构造器（六行共用它 ⇒ 结构必然一致，⛔ 不允许某行自己拼一套）
  assert.ok(/const field = \(label, \.\.\.controls\) => React\.createElement\('div', \{ className: 'va-row' \},/.test(s),
    '行构造器 field(label, ...controls) 须在位且只此一份（变长签名 = 不会静默丢控件）');
  assert.ok(s.includes("React.createElement('span', { className: 'va-lb' }, label)"),
    '行内标签须走 .va-lb（固定宽列）');
  assert.ok(s.includes("className: 'va-ct' }, controls.length === 1 ? controls[0] : controls"),
    '行内控件须走 .va-ct（弹性列），多控件合并渲染');
  // ② 主网格 = 四个下拉格 + 两个**已具名**的格（hotkeyField / noiseField）
  //   ⚠ 热键/噪声两行在自己那两处就已经调用 field(...) 构造，网格里只是把结果放进去 ⇒
  //     网格块内直接调用 field( 的次数是 **4**，不是 6。旧断言写成 6 是数错了层次。
  const gi = s.indexOf('const controlsGrid = React.createElement');
  assert.ok(gi > 0, '前置：须能定位主网格');
  const gj = s.indexOf(String.fromCharCode(10) + '  const body =', gi);
  assert.ok(gj > gi, '前置：须能定位主网格结束');
  const gridBlock = s.slice(gi, gj);
  const inlineFields = gridBlock.split("field(").length - 1;
  assert.equal(inlineFields, 4, '主网格须恰 4 个内联 field（四个下拉）；实得 ' + inlineFields);
  assert.ok(/^\s+hotkeyField,/m.test(gridBlock), '主网格须含 hotkeyField（已具名的热键格）');
  assert.ok(/^\s+noiseField,/m.test(gridBlock), '主网格须含 noiseField（已具名的噪声格）');
  // 六格全都走同一个 field 构造器（含热键/噪声两处自己的调用）
  const allFields = s.split("field(t(").length - 1;
  assert.equal(allFields, 6, '六格须全部走同一个 field 构造器；实得 ' + allFields);
  // ③ ⛔ 代码层不得写死 gridTemplateColumns（列数由 CSS 统一决定；当前口径 = 恒两栏、无响应式切换）
  const codeOnly = s.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  assert.equal(/gridTemplateColumns/.test(codeOnly), false,
    '⛔ 代码层不得出现 gridTemplateColumns（列数交给 CSS，避免同一列数写两处）');
});

test('GEOLOCK-04 热键行与噪声行**完全同构**（输入框 + 尾部同一图标按钮）', () => {
  const s = voiceSrc();
  // 用户逐字：「环境噪声的样式和语音热键的样式完全对齐一致，就是输入框可以自定义输入，后面一个小符号代表测试」
  const hot = sliceBetween(s, 'const hotkeyField = field(', 'const noiseField = field(');
  const noise = sliceBetween(s, 'const noiseField = field(', '\n  // ═══');
  // ① 两行都走同一个 unitField（结构必然同构），按钮都走同一个 iconBtn
  assert.ok(/unitField\{/.test(hot) || /unitField\(/.test(hot), '热键行须走 unitField');
  assert.ok(/unitField\(/.test(noise), '噪声行须走 unitField');
  assert.ok(/iconBtn\(t\('voiceHotkeyClear'\)/.test(hot), '热键行尾部须是 iconBtn（清除）');
  assert.ok(/iconBtn\(measuring/.test(noise), '噪声行尾部须是 iconBtn（测试）');
  // ② 尾图标构造器只有一处（两行共用 ⇒ 严格同形）
  assert.equal((s.match(/const iconBtn = \(title, glyph, onClick, disabled\) =>/g) || []).length, 1,
    'iconBtn 构造器须只此一份（两行共用同一形态）');
  // ②b unitField 构造器也只有一处（结构同构的根本）
  assert.equal((s.match(/const unitField = /g) || []).length, 1, 'unitField 构造器须只此一份');

  // ③ 噪声输入框必须**可编辑**（用户逐字「输入框可以自定义输入」）⇒ ⛔ 不得 readOnly
  assert.equal(/inputMode: 'decimal'[\s\S]{0,400}readOnly/.test(noise), false,
    '⛔ 噪声输入框不得 readOnly（用户要求可自定义输入）');
  assert.ok(/readOnly: true/.test(hot), '热键输入框仍是只读（录制键组合，不接受手打）');
  // ④ 单位 dBFS 以内嵌后缀承载（⛔ 不是旁边的独立文本节点）
  assert.ok(/unitField\([\s\S]{0,400}'dBFS'/.test(noise), '噪声单位须作 unitField 的 suffix 参数传入');
});

// ⚠ PE-41 修复（2026-11-17 · 全功能审查 low）：标题原写「固定 26px」，而实测 CSS 为 **22px**
//   （`styles.cjs:203` 的图标按钮）—— 读标题即错，断言本身是对的。
test('GEOLOCK-05 两行之所以等宽：CSS 上控件列同宽 + 图标按钮同为固定 22px', () => {
  const st = styleSrc();
  // ① 行：flex + 固定标签列 + 弹性控件列
  const row = st.match(/'\.va-row\{([^}]*)\}'/);
  assert.ok(row, 'styles.js 须有 .va-row 规则');
  assert.ok(/display:flex/.test(row[1]), '.va-row 须是 flex');
  assert.ok(/align-items:center/.test(row[1]), '.va-row 须垂直居中（⛔ 不得 stretch）');
  const lb = st.match(/'\.va-lb\{([^}]*)\}'/);
  assert.ok(lb, 'styles.js 须有 .va-lb 规则');
  assert.ok(/flex:none/.test(lb[1]), '标签列须 flex:none（⛔ 不参与再分配，否则各行标签宽不同 ⇒ 控件列起点漂移）');
  assert.ok(/width:76px/.test(lb[1]), '标签列须有统一固定宽（各行对齐的成因）；实得 ' + lb[1].slice(0, 60));
  const ct = st.match(/'\.va-ct\{([^}]*)\}'/);
  assert.ok(ct, 'styles.js 须有 .va-ct 规则');
  assert.ok(/flex:1 1 auto/.test(ct[1]), '控件列须 flex:1 1 auto（吃满剩余，两行才同宽）');
  // ② 尾部按钮（2026-11-14 · 用户裁定方案 1）：内置到输入框内右端，不再是框外按钮
  const ib = st.match(/'[.]va-unit-btn[{]([^}]*)[}]'/);
  assert.ok(ib, 'styles.js 须有 .va-unit-btn 规则（框内按钮）');
  assert.ok(/position:absolute/.test(ib[1]), '.va-unit-btn 须绝对定位（内置在输入框内）');
  assert.ok(/right:6px/.test(ib[1]), '.va-unit-btn 须 right:6px（与下拉箭头同位）');
  assert.ok(/width:22px/.test(ib[1]), '.va-unit-btn 须 22×22');
  assert.ok(/border:none/.test(ib[1]), '不得有边框（带边框就退回框外按钮观感）');
  assert.ok(/background:transparent/.test(ib[1]), '.va-unit-btn 底色须透明');
  assert.equal(st.includes('.va-iconbtn{'), false, '不得残留 .va-iconbtn（框外按钮形态已退役）');
  const sfx = st.match(/'[.]va-unit > [.]va-suffix[{]([^}]*)[}]'/);
  assert.ok(sfx, 'styles.js 须有 .va-unit > .va-suffix 规则');
  assert.ok(/position:absolute/.test(sfx[1]), '.va-suffix 须绝对定位');
  assert.ok(/pointer-events:none/.test(sfx[1]), '.va-suffix 须 pointer-events:none');
  assert.ok(/right:34px/.test(sfx[1]), '.va-suffix 须 right:34px（站在按钮左侧）');
  const unitInp = st.match(/'[.]va-unit > [.]dsh-plg-input[{]([^}]*)[}]'/);
  assert.ok(unitInp, 'styles.js 须有 .va-unit > .dsh-plg-input 规则');
  assert.ok(/padding-right:34px/.test(unitInp[1]), '无单位行须留 34px 给按钮');
  const hasSuffix = st.match(/'[.]va-unit[.]va-has-suffix > [.]dsh-plg-input[{]([^}]*)[}]'/);
  assert.ok(hasSuffix, 'styles.js 须有 .va-unit.va-has-suffix > .dsh-plg-input 规则');
  assert.ok(/padding-right:70px/.test(hasSuffix[1]), '带单位行须留 70px');
});

test('GEOLOCK-10 内嵌按钮必须在 .va-unit 内（fail-closed：防静默丢参）', () => {
  const s = voiceSrc();
  // 病历：field(label, control) 原只接一个控件，而两行各传了两个 => 按钮被静默丢弃、从未渲染。
  assert.ok(/const field = [(]label, [.][.][.]controls[)] =>/.test(s),
    'field() 必须接受变长控件（不得退回 (label, control)）');
  const uses = s.match(/unitField[(]/g) || [];
  const defCount = (s.match(/const unitField = /g) || []).length;
  const useCount = (s.match(/unitField[(][{]/g) || []).length;
  assert.equal(defCount, 1, 'unitField 构造器须只此一份');
  assert.ok(useCount >= 2, 'unitField 须被两行各用一次；实得 ' + useCount);
  assert.ok(/const unitField = [(]inputProps, suffix, actionBtn[)] =>/.test(s), 'unitField 构造器须在位');
  assert.ok(/className: 'va-unit-btn'/.test(s), 'iconBtn 须产出 .va-unit-btn（框内按钮）');
  assert.equal(/dsh-plg-btn-icononly va-iconbtn/.test(s), false, 'iconBtn 不得再产出框外按钮类');
});

test('GEOLOCK-06 主网格恒两栏且**无任何单列切换**（⛔ 不回 auto-fit / 不加 @media 单列分支）', () => {
  const st = styleSrc();
  const g = st.match(/'\.va-grid2\{([^}]*)\}'/);
  assert.ok(g, 'styles.js 须有 .va-grid2 规则');
  // 2026-11-13（用户两次裁定 · 断点定案）：**恒两栏，不做任何单列切换**。
  //   病历①：原 repeat(auto-fit,minmax(320px,1fr)) 两栏需 668px，而 DSH 设置弹窗内容宽实测 ~667px
  //     ⇒ 差 1px 退单列，用户在电脑 Web 端看到的就是单列（他原话「电脑 web 端不应该是窄屏啊」）。
  //   病历②：本席曾补一条 max-width 媒体查询想兜「极窄」，被用户明确叫停——
  //     「不是在极窄时退单列，你切换到单列的判断就不对，应该是根据显示的比例判断…
  //       当然我说了当前这个不需要做，不需要切换单列，停止这个功能」。
  //   ⇒ 判据锁死三件：①恒两栏 ②无 auto-fit ③**不得存在任何单列分支**（max-width / orientation 皆禁）。
  assert.ok(/grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/.test(g[1]), '.va-grid2 须恒两栏（repeat(2,minmax(0,1fr))）');
  assert.equal(/auto-fit/.test(g[1]), false, '⛔ 不得回到 auto-fit（断点会随列宽隐式抬高，正是病历①）');
  assert.equal(/@media/.test(st.slice(st.indexOf('\.va-grid2{'), st.indexOf('\.va-grid2{') + 400)), false,
    '⛔ .va-grid2 附近不得出现 @media 单列分支（用户明确叫停单列功能）');
  assert.equal(/@media[^{]*\.va-(grid2|dict2)/.test(st), false,
    '⛔ 全表不得有任何针对 .va-grid2/.va-dict2 的 @media（不再按宽度切换）');
});

test('GEOLOCK-07 状态区 = 一行摘要 + 诊断按钮（详情默认收起但**不得丢**）', () => {
  const s = voiceSrc();
  // ① 一行摘要：点 + 状态词 + 摘要文本 + 右侧按钮
  assert.ok(/className: 'va-sum'/.test(s), '状态区须是 .va-sum（一行）');
  assert.ok(/className: 'va-more'/.test(s), '状态区须有 .va-more（诊断按钮）');
  assert.ok(/'aria-expanded': diagOpen \? 'true' : 'false'/.test(s), '诊断按钮须带 aria-expanded（可访问性）');
  // ② 默认收起（用户认领项）——初值必须是 false
  assert.ok(/const \[diagOpen, setDiagOpen\] = React\.useState\(false\)/.test(s),
    '诊断详情须默认收起（useState(false)）');
  // ③ ⛔ 折叠不得把三条诊断丢掉（不得静默失效）：组件仍须全部在渲染树里
  for (const comp of ['OfficialVoiceDiag', 'FillerDiag', 'CorrectionDiag']) {
    assert.ok(new RegExp('React\\.createElement\\(' + comp + ', props\\)').test(s),
      '⛔ 折叠后 ' + comp + ' 仍须渲染（不得静默失效）');
  }
  // ④ 原始读数出口仍在（title 承载 providers）
  assert.ok(/title: speechReady \? \('providers='/.test(s), '原始读数须保留在 title（可见文案改白话、读数不丢）');
});

test('GEOLOCK-08 学习词典 = 双集合（⛔ 不得退回逐条启停按钮）', () => {
  const s = voiceSrc();
  // ① 两个集合容器都在（使用中 / 已停用）
  assert.ok(/const activeBox = React\.createElement\('div', \{ className: 'va-box' \}/.test(s),
    '「使用中」集合容器须在位');
  assert.ok(/const offBox = React\.createElement\('div', \{ className: 'va-box va-box-off' \}/.test(s),
    '「已停用」集合容器须在位（带 va-box-off ⇒ 视觉上不生效）');
  // ② 状态由 enabled 派生（单一事实源；⛔ 不新增第二份状态字段）
  assert.ok(/entries\[i\]\.enabled === false \? offIdx : activeIdx/.test(s),
    '两个集合须由 entries[i].enabled **派生**（单一事实源）');
  // ③ 移组 = 写 enabled（不是「点开关」）
  // ⚠⚠ 2026-11-17 本轮体修订（F04-1）：**原断言只锁字符串 `patchAt(i,{enabled:false})`，
  //   而 PE-20 把 patchAt 改成「只置草稿、不 commit」后，移组按钮**点击完全无效果**，
  //   本断言仍全绿**——它锁的是调用形态，不是「真的写了配置」**。典型「判据没牙」。
  //   现改为**行为契约断言**（三条合取，仍静态可判但锁到落盘语义）：
  //     ① 移组按钮必须走 `toggleAt`；② `toggleAt` 内必须有 `commit(`（立即落配置）；
  //     ③ 文本输入用的 `patchDraftAt` 内**不得**有 `commit(`（保持 PE-20 的延迟提交本意）。
  assert.ok(/toggleAt\(i, \{ enabled: true \}\)/.test(s), '移回必须走 toggleAt（立即落配置），不得走只置草稿的路径');
  assert.ok(/toggleAt\(i, \{ enabled: false \}\)/.test(s), '移出必须走 toggleAt（立即落配置），不得走只置草稿的路径');
  {
    // ⚠⚠ 2026-11-17 第二轮体检**修无牙断言**：上一版用固定长度窗口 `s.slice(idx, idx+600)`，
    //   而该窗口**越过了 toggleAt 的闭合花括号**、把紧随其后的 `removeAt` / `addOne` 也纳进来 ——
    //   那两个函数本来就有 `commit(` ⇒ **把 toggleAt 改成只置草稿（正是 F04-1 的缺陷形态）断言仍全绿**
    //   （reviewer 实测 26 pass / 0 fail）。⇒ 必须按**函数体边界**取，不能用固定长度。
    const bodyOf = (src, decl) => {
      const i = src.indexOf(decl);
      if (i < 0) return null;
      const open = src.indexOf('{', i);
      if (open < 0) return null;
      let depth = 0;
      for (let k = open; k < src.length; k++) {
        if (src[k] === '{') depth++;
        else if (src[k] === '}') { depth--; if (depth === 0) return src.slice(i, k + 1); }
      }
      return null;
    };
    const toggleBody = bodyOf(s, 'const toggleAt');
    assert.ok(toggleBody !== null, '必须能按花括号配平取出 toggleAt 的函数体（取不到 ⇒ 判据无被测物，不得静默通过）');
    assert.ok(/commit\(/.test(toggleBody), 'toggleAt **函数体内**必须调用 commit() —— 否则按钮点了不写配置（F04-1 的形态）');
    // 负控：函数体不得把 commit 只写在注释里（注释里出现 commit( 不算实现）
    const toggleCode = toggleBody.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(/commit\(/.test(toggleCode), 'toggleAt 的 commit() 必须是**真实代码**，不得只在注释里出现');
    const draftBody = bodyOf(s, 'const patchDraftAt');
    assert.ok(draftBody !== null, '必须能按花括号配平取出 patchDraftAt 的函数体');
    const draftCode = draftBody.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.equal(/commit\(/.test(draftCode), false, 'patchDraftAt **函数体内**（去注释后）不得 commit —— 否则 PE-20 的「输入中途不归一」失效');
  }
  // ④ ⛔ 不得退回每行一个启停开关（旧形态：aria-pressed + voiceDictEnable/Disable 作按钮文本）
  assert.equal(/'aria-pressed'/.test(s), false, '⛔ 词条不得再有 aria-pressed 启停按钮（旧结构）');
  assert.equal(/t\('voiceDictEnable'\) \? t\('voiceDictDisable'\)/.test(s), false,
    '⛔ 不得按 enabled 三元切换按钮文案（那是逐条开关的形态）');
  // ⑤ 新增入口在「使用中」集合内（新建即生效）
  assert.ok(/className: 'va-item va-add'/.test(s), '新增行须在「使用中」集合内（va-add）');
  // ⑥ 浅底 + 降色：已停用的两重可辨识
  const st = styleSrc();
  assert.ok(/'\.va-box-off\{([^}]*)\}'/.test(st), 'styles.js 须有 .va-box-off 规则');
  assert.ok(/\.va-box-off \.va-item > \.va-dict-in\{/.test(st), '已停用集合的词条文本须降一档颜色');
});

test('GEOLOCK-09 两块卡片 = 同款边界（并列层级不得回退成"从属"）', () => {
  const st = styleSrc();
  const sec = st.match(/'\.dsh-cfg-sec\{([^}]*)\}'/);
  assert.ok(sec, 'styles.js 须有 .dsh-cfg-sec 规则');
  assert.ok(/border:1px solid/.test(sec[1]), '两块须各有一圈边框（视觉并列的载体）');
  assert.ok(/border-radius/.test(sec[1]), '两块须有圆角');
});

// ───────── 变异自证（锁必须"有牙"）─────────

test('GEOLOCK-V1 变异自证：把档位文案拼回「开 ·」前缀 ⇒ GEOLOCK-02 必红', () => {
  const s = voiceSrc();
  const mutated = s.replace(
    "{ value: '', text: t('voiceAutoEnhanceModeFollow') }",
    "{ value: '', text: t('voiceAutoEnhanceOn') + ' · ' + t('voiceAutoEnhanceModeFollow') }");
  assert.notEqual(mutated, s, '前置：变异锚点须命中');
  const mi = mutated.indexOf('const autoEnhanceOptions =');
  const seg = mutated.slice(mi, mutated.indexOf(String.fromCharCode(59, 10), mi));
  assert.equal(/voiceAutoEnhanceOn/.test(seg), true, '变异后 GEOLOCK-02 的断言必红（前缀被拼回）');
});

test('GEOLOCK-V2 变异自证：把噪声行退回只读 ⇒ GEOLOCK-04 必红；改回独立开关 ⇒ GEOLOCK-01 必红', () => {
  const s = voiceSrc();
  // ① 噪声输入框加回 readOnly
  const m1 = s.replace("      inputMode: 'decimal',",
    "      inputMode: 'decimal', readOnly: true,");
  assert.notEqual(m1, s, '前置：噪声输入框锚点须命中');
  const noiseSeg = m1.slice(m1.indexOf('const noiseField = field('));
  assert.equal(/inputMode: 'decimal'[\s\S]{0,120}readOnly/.test(noiseSeg.slice(0, 900)), true,
    '变异后 GEOLOCK-04 的「可编辑」断言必红');
  // ② 退回独立开关按钮（ToggleChip 重新出现）
  const m2 = s + '\nconst ToggleChip = (p) => p;\n';
  assert.equal(/ToggleChip/.test(m2), true, '变异后 GEOLOCK-01 的「无 ToggleChip」断言必红');
});

test('GEOLOCK-V3 负控：不动任何文件 ⇒ 本锁全绿（防"恒红"）', () => {
  const s = voiceSrc();
  assert.ok(s.length > 1000, '源码可读');
  // 四个下拉 + 行构造器 + 图标构造器都在位
  assert.ok(/const field = \(label, \.\.\.controls\) =>/.test(s), '行构造器在位（变长签名）');
  assert.ok(/const iconBtn = \(title, glyph, onClick, disabled\) =>/.test(s), '图标构造器在位');
  assert.ok(/const activeBox = /.test(s) && /const offBox = /.test(s), '词典双集合在位');
  assert.ok(styleSrc().length > 1000, 'styles 可读');
});

// ══════════════════════════════════════════════════════════════════════════════
// 2026-10-18（结构回归锁批）新增：**两条机载锁**（GEOLOCK-A* / GEOLOCK-B*）
//
// 由来（上一批自己提、本席采纳）：上一批把「语音必须在 tab 层」与「模型行固定宽合计 ≤ 534」
//   只写成了 /tmp 里的临时判据（check-a / check-c），**未入库** ⇒ 谁把语音移回「模型配置」
//   正文的卡片、谁把 provider 下限调回 104，npm test 都抓不到（= F-5 那条装置缺口）。
//   本批把这两条的**结构腿**并进本文件（本文件已在 scripts.test 清单内 ⇒ 真机载）。
//
// ⚠ 仍**不依赖浏览器**（硬约束）：两条锁只读「源码结构」与「CSS 声明值」（成因面），
//   ⛔ 不跑 headless Chrome。理由同文件头：CI / 干净 clone 上不保证有 Chrome ⇒ 写成
//   「必须跑浏览器」的锁会长期 SKIP = 等于没有锁。像素量测仍归
//   scripts/settings-layout-audit.mjs（人工/部署前预检），两者互补。
//
// ⚠ 判据范围（否定性断言的**范围**必须写明）：
//   · A 组只判 src/client/components/** 与 src/client/voice/** 这些 client chunk 的
//     **代码面**（已剥注释）—— ⛔ 不判 lib/client.cjs 产物字节、⛔ 不判运行期 DOM 层级、
//     ⛔ 不判样式"看起来是否平级"（后者是像素锁的面）。
//   · B 组只判 .dsh-plg-row（模型链条目行）内**本仓自己声明**的宽度；⛔ 不判宿主侧容器
//     实际给了多少宽（那是真机量测的面，见 MODEL_ROW_AVAILABLE_PX 的来源注释）。
// ══════════════════════════════════════════════════════════════════════════════

/** 读某 client chunk 的**代码面**（已剥注释）。 */
async function codeOf(rel) {
  const { codeOnly } = await import('../scripts/lib/code-only.mjs');
  if (rel.endsWith('.cjs')) {
    const fs = require('node:fs');
    return codeOnly(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
  }
  return codeOnly(decodeChunk(rel));
}

// ───────── 锁 A（2026-10-19 已反向）：语音块必须在「模型配置」tab 内、与模型卡片同级 ─────────
//
// ⚠ 本锁的方向**在这一批被反转**（原方向见 0deffcc：那时断言「语音必须在 tab 层」）。
//   反转原因：用户在 2026-10-19 推翻了 CHG-202 的 tab 方案，原话逐字——
//     「模型配置和语音输入不用分两个 tab 进入，还是之前的一样在一个 tab 界面」。
//   ⇒ 正解是**同一 tab 内的两个平级板块**（不是页签平级，也不是嵌在对方卡片里）。
//   ⇒ 锁的判据随之变成三条：①语音块在「模型配置」tab 之内；②它与模型配置卡片是**同级兄弟**；
//     ③它**不得**再作为独立 tab 出现。两条错误方向（嵌进去 / 提成 tab）都必须被挡住。
//
// ⚠ 判据范围（否定性断言的**范围**必须写明）：只判 src/client/components/** 与 src/client/voice/**
//   这些 client chunk 的**代码面**（已剥注释）；⛔ 不判产物字节、⛔ 不判运行期 DOM 层级。
//   运行期层级的读数由 scripts/settings-layout-audit.mjs 的 geom 快照另测（见本批报告 §④）。

/** 页内 tab 表的解析结果：{ block, entries:[{key,labelKey}] }；解析不出返回 null（fail-closed）。 */
function parseTabTable(pluginsCode) {
  const head = 'const tabs = [';
  const i = pluginsCode.indexOf(head);
  if (i < 0) return null;
  const j = pluginsCode.indexOf('];', i);
  if (j < 0) return null;
  const block = pluginsCode.slice(i, j + 2);
  const entries = [];
  const re = /\[\s*'([a-z-]+)'\s*,\s*t\('([A-Za-z0-9_]+)'\)\s*\]/g;
  let m;
  while ((m = re.exec(block)) !== null) entries.push({ key: m[1], labelKey: m[2] });
  return { block: block, entries: entries };
}

/** tab 正文分派：models / params 两支各自渲染哪个组件（解析不出为 null）。
 *  ⚠ 2026-10-19：voice 支**已按用户要求删除** ⇒ 本解析器不再有 voice 字段（有它即等于语音又成了 tab）。 */
function parseTabBodyDispatch(pluginsCode) {
  const pick = (re) => { const m = pluginsCode.match(re); return m ? m[1] : null; };
  return {
    models: pick(/tab === 'models'\s*\?\s*React\.createElement\((ModelConfigTab)\b/),
    params: pick(/:\s*React\.createElement\((ParamsTab)\b/),
  };
}

/** ⭐ 模型配置 tab 正文的**顶层子项**序列（只取 return 里 React.Fragment 的直接子项）。
 *  用途：判「语音块与模型卡片是否同级兄弟」——即两者都是同一个 Fragment 的直接子项、
 *  且顺序上「语音」紧跟在「模型配置」之后（同级、无包裹）。
 *  解析不出返回 null（fail-closed）。 */
function parseCfgTabTopLevel(cfgCode) {
  const head = 'return React.createElement(React.Fragment, null,';
  const i = cfgCode.indexOf(head);
  if (i < 0) return null;
  const j = cfgCode.indexOf('\n  );', i);
  if (j < 0) return null;
  const body = cfgCode.slice(i + head.length, j);
  // 顶层子项 = 行首（两/四个空格缩进后）以 React.createElement(...) 开头的调用
  const rows = [];
  const re = /^\s*React\.createElement\((\w+)/gm;
  let m;
  while ((m = re.exec(body)) !== null) rows.push(m[1]);
  return rows;
}

test('GEOLOCK-A1 页内 tab 表只能是 models / params 两项（⛔ 语音不得再是 tab）', async () => {
  const plugins = await codeOf('src/client/domains/settings/plugins-section.cjs');
  const tabTable = parseTabTable(plugins);
  assert.ok(tabTable, '前置：须能定位页内 tab 表 const tabs = [...]');
  const keys = tabTable.entries.map((e) => e.key);
  // ① 只剩两个 tab（用户 2026-10-19 推翻三 tab 方案）
  assert.deepEqual(keys, ['models', 'params'],
    '⭐ 页内 tab 表须恰为 models / params 两项（语音不再单独占一个 tab）；实得 ' + JSON.stringify(keys));
  // ② ⛔ 语音绝不能再作为 tab 出现（这是本锁要挡的第一个错误方向）
  assert.equal(keys.indexOf('voice'), -1,
    '⛔ 语音不得再作为一个 tab（用户原话「不用分两个 tab 进入」）；实得 ' + JSON.stringify(keys));
  // ③ 表里不得出现第三项
  assert.equal(tabTable.entries.length, 2, '页内 tab 表须恰为 2 项；实得 ' + tabTable.entries.length);
});

test('GEOLOCK-A2 tab 正文分派只剩 models / params 两支（⛔ 无 voice 分支）', async () => {
  const plugins = await codeOf('src/client/domains/settings/plugins-section.cjs');
  const dispatch = parseTabBodyDispatch(plugins);
  assert.equal(dispatch.models, 'ModelConfigTab', 'models 分支须渲染 ModelConfigTab');
  assert.equal(dispatch.params, 'ParamsTab', 'params 分支须渲染 ParamsTab');
  // ⛔ 不得存在 voice 分支（它一旦回来，语音就又是一个 tab）
  assert.equal(/tab === 'voice'/.test(plugins), false,
    "⛔ 正文分派里不得再出现 tab === 'voice' 分支（语音已回到「模型配置」tab 内）");
  assert.equal(/<VoiceSection\b|createElement\(VoiceSection\b/.test(plugins), false,
    '⛔ ModelPluginsSection 不得直接挂 VoiceSection（那是「语音=tab」形态的残留）');
});

test('GEOLOCK-A3 ⭐ 语音块必须在「模型配置」tab 之内，且与模型配置卡片是同级兄弟', async () => {
  const cfgTab = await codeOf('src/client/domains/settings/model-config-tab.cjs');
  // ① 语音块**在里面**（正文顶层挂一个 VoiceSection）
  assert.ok(/React\.createElement\(VoiceSection\b/.test(cfgTab),
    '⭐ ModelConfigTab 的代码里必须挂 VoiceSection（语音块回到「模型配置」tab 内）');
  // ② 与模型配置卡片**同一父级、同一层级**：两者都是 return 的 React.Fragment 直接子项
  const top = parseCfgTabTopLevel(cfgTab);
  assert.ok(top, '前置：须能定位 ModelConfigTab 的 return React.createElement(React.Fragment, null, …) 块');
  assert.ok(top.indexOf('ModelMainSection') >= 0, '前置：顶层子项须含 ModelMainSection；实得 ' + JSON.stringify(top));
  assert.ok(top.indexOf('VoiceSection') >= 0, '⭐ 顶层子项须含 VoiceSection（同级兄弟）；实得 ' + JSON.stringify(top));
  // ③ 同级 = 两者都是**顶层直接子项**（不是其中一个被塞进另一个的 props.children）
  const iModel = top.indexOf('ModelMainSection');
  const iVoice = top.indexOf('VoiceSection');
  assert.notEqual(iModel, -1, '前置：ModelMainSection 在顶层');
  assert.notEqual(iVoice, -1, 'VoiceSection 在顶层');
  // ④ 语音**紧跟**在模型配置之后（这一对就是「两块并列」的结构表达）
  assert.equal(iVoice, iModel + 1,
    '⭐ VoiceSection 须紧接 ModelMainSection 之后（两块平级并列、中间不得夹入别的层级）；实得序列 ' + JSON.stringify(top));
});

test('GEOLOCK-A4 VoiceSection 全 client chunk 只挂载**一处**，且该处就是「模型配置」tab 正文', async () => {
  const { codeOnly } = await import('../scripts/lib/code-only.mjs');
  const scanClientSources = (dir, out) => {
    for (const ent of require('node:fs').readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) scanClientSources(full, out);
      else if (/\.(?:js|cjs)$/.test(ent.name)) out.push(path.relative(ROOT, full).split(path.sep).join('/'));
    }
    return out;
  };
  const clients = scanClientSources(path.join(ROOT, 'src/client'), []);
  // 目标模式会持续把 chunk 迁为普通模块，因此不能把当前剩余数量写成前置阈值。
  // 只锁“枚举非空 + 关键挂载点文件在扫描面内”，防止空枚举导致后面的否定断言空转。
  assert.ok(clients.length > 0, '前置：client chunk 枚举须非空（实得 ' + clients.length + '）');
  assert.ok(clients.includes('src/client/domains/voice/section.cjs'),
    '前置：VoiceSection 的合法挂载点须在扫描面内');
  assert.ok(clients.includes('src/client/domains/settings/model-config-tab.cjs'),
    '前置：ModelConfigTab 的合法挂载点须在扫描面内');
  const sites = [];
  for (const rel of clients) {
    const raw = rel.endsWith('.cjs')
      ? require('node:fs').readFileSync(path.join(ROOT, rel), 'utf8')
      : decodeChunk(rel);
    const code = codeOnly(raw);
    const n = (code.match(/React\.createElement\(VoiceSection\b/g) || []).length;
    if (n > 0) sites.push(rel + ' x' + n);
  }
  // 唯一挂载点 = 「模型配置」tab 正文（多一处或换一处都立刻变红）
  assert.deepEqual(sites, ['src/client/domains/settings/model-config-tab.cjs x1'],
    'VoiceSection 须**只在** ModelConfigTab 正文挂载一次；实得 ' + JSON.stringify(sites));
});

test('GEOLOCK-A5 语音块标题 = 「语音增强」（中英各一），且两个 tab 标签均在 i18n 两侧', () => {
  const dict = { ZH, EN };
  assert.equal(typeof dict.ZH, 'object', '前置：ZH 字典须可求值');
  assert.equal(typeof dict.EN, 'object', '前置：EN 字典须可求值');
  // ① 两个 tab 的标签键在两侧都存在
  for (const k of ['tabModels', 'tabParams']) {
    assert.equal(typeof dict.ZH[k], 'string', 'ZH 缺 tab 标签键 ' + k);
    assert.equal(typeof dict.EN[k], 'string', 'EN 缺 tab 标签键 ' + k);
  }
  // ② ⭐ 块标题已改名：语音输入 → 语音增强（用户本轮要求）
  assert.equal(dict.ZH.voiceSectionTitle, '语音增强',
    '⭐ ZH 的 voiceSectionTitle 须为「语音增强」；实得 ' + JSON.stringify(dict.ZH.voiceSectionTitle));
  assert.equal(dict.EN.voiceSectionTitle, 'Voice Enhancement',
    '⭐ EN 的 voiceSectionTitle 须为「Voice Enhancement」；实得 ' + JSON.stringify(dict.EN.voiceSectionTitle));
  // ③ 页面标题 = 「提示词 · 语音增强」（⛔ 无任何前置符号）
  assert.equal(dict.ZH.navModelPlugins, '提示词 · 语音增强',
    '⭐ ZH 的 navModelPlugins 须为「提示词 · 语音增强」；实得 ' + JSON.stringify(dict.ZH.navModelPlugins));
  assert.equal(/^[\u4e00-\u9fa5]/.test(dict.ZH.navModelPlugins), true,
    '⛔ 页面标题不得以任何符号/emoji 开头（须以中文起头）；实得 ' + JSON.stringify(dict.ZH.navModelPlugins));
  // ④ 两个 tab 标签互不相同
  const zh = ['tabModels', 'tabParams'].map((k) => dict.ZH[k]);
  assert.equal(new Set(zh).size, 2, '两个 tab 中文标签须互不相同；实得 ' + JSON.stringify(zh));
});

test('GEOLOCK-A-V 变异自证：两个错误方向各自打红（嵌回卡片内 / 改回独立 tab）+ 负控', async () => {
  const plugins = await codeOf('src/client/domains/settings/plugins-section.cjs');
  const cfgTab = await codeOf('src/client/domains/settings/model-config-tab.cjs');

  // ⭐ 方向①：把语音**嵌进模型配置卡片内部**（= 退回从属；本轮之前的错误方向之一）
  //   做法：不再作为顶层子项，而是塞进 ModelMainSection 的 props 里（当成它的孩子）。
  const nested = cfgTab.replace(
    'React.createElement(VoiceSection, { t: t }),',
    'React.createElement(ModelMainSection, { t: t, children: React.createElement(VoiceSection, { t: t }) }),');
  assert.notEqual(nested, cfgTab, '前置：方向①锚点须命中（顶层 VoiceSection 那一行）');
  const topNested = parseCfgTabTopLevel(nested);
  // ⇒ A3 的「语音是顶层子项」必红
  assert.equal(topNested.indexOf('VoiceSection') >= 0, false,
    '方向①后 GEOLOCK-A3 必红（语音不再是顶层同级兄弟，已被嵌进模型卡片）');
  assert.equal(topNested.indexOf('ModelMainSection') >= 0, true, '方向①后 ModelMainSection 仍应在顶层');

  // ⭐ 方向②：把语音**改回独立 tab**（= 本批正在纠正的那个过度方案）
  const asTab = plugins
    .replace("    ['params', t('tabParams')],", "    ['voice', t('tabVoice')],\n    ['params', t('tabParams')],")
    .replace("const body = tab === 'models'", "const body = tab === 'voice' ? React.createElement(VoiceSection, props)\n    : tab === 'models'");
  assert.notEqual(asTab, plugins, '前置：方向②锚点须命中（tab 表末项 + 正文分派首支）');
  const t2 = parseTabTable(asTab);
  // ⇒ A1 的「tab 只有两项、且无 voice」必红
  assert.deepEqual(t2.entries.map((e) => e.key), ['models', 'voice', 'params'],
    '方向②后 A1 必红（语音又成了一个 tab）');
  assert.notEqual(t2.entries.map((e) => e.key).indexOf('voice'), -1, '方向②后 A1 的「无 voice」腿必红');
  // ⇒ A2 的「无 voice 分支」也必红
  assert.equal(/tab === 'voice'/.test(asTab), true, '方向②后 A2（无 voice 分支）必红');

  // 负控：不动任何文件 ⇒ 上述断言在**原文件**上均成立（防「恒红」）
  assert.ok(/React\.createElement\(VoiceSection\b/.test(cfgTab), '负控：原文件确实挂载 VoiceSection');
  assert.deepEqual(parseTabTable(plugins).entries.map((e) => e.key), ['models', 'params'], '负控：tab 表恰两项');
  assert.deepEqual(parseCfgTabTopLevel(cfgTab).filter((x) => x === 'ModelMainSection' || x === 'VoiceSection'),
    ['ModelMainSection', 'VoiceSection'], '负控：两块为同级兄弟且语音在后');
});

// ───────── 锁 B：模型行固定宽合计 ≤ 真机可用宽 ─────────

// ⭐⭐ 本锁的**唯一魔数**：真机可用宽（= 模型链条目行的 row1 宽）。**具名 + 注明来源**，
//   ⛔ 不许在别处再出现一次字面量（GEOLOCK-B5 会自检这一点）。
//
//   来源（三条独立读数，均为只读实读，不是本轮估算）：
//   ① CHG-196 实测：宿主设置面板 .VOzbGW_panel 是**定值 800px** ⇒ 内容盒 564；
//      .dsh-vi-section / 模型行 row1 = 534。⚠ 窗口从 602 扫到 2382，panel 恒 800
//      ⇒ **真机上不存在"700px 内容区"**（那是更上一轮从截图估的数，已作废，不得当依据）。
//   ② 本仓量测装置同一事实的**代码注释**（scripts/lib/settings-layout-driver.mjs:191）：
//      「row1 = root - 30（真机实测恒定偏移：宿主 padding 链 root 564 → row1 534）」
//      —— 装置的 30 偏移与 534 是同一条实测链（B5 会拿这两个数互算校验）。
//   ③ 溢出读数也以它为分母：改前实测 scrollWidth 586 vs clientWidth 534（**溢出 52px**），
//      改后 0px（2026-10-18 ia-parity 批报告 §⑥）。
//   ⚠ 因此 534 **不是**可以挑的数（不是断点、不是设计稿值），是宿主给的硬边界。
const MODEL_ROW_AVAILABLE_PX = 534;

// 行内**固定宽项**（不可被压缩的项）：逐项声明 + 从 CSS 实读下限。
//   ⚠ 每项都写明"为什么它是固定宽项"，与 ia-parity 批 §⑤ 的因果表一一对应。
// 2026-11-14（模型行统一批 · 用户裁定「开关并入档位」）：固定宽项 4 → 3 ——
//   原 thinking（开/关 56px）+ level（档位 62px）两个控件合并成**一个**档位下拉（Off 即关闭）。
//   合并后档位列 100 = 厂家列 100（用户要求「边框宽窄在视觉上一致」）。
const MODEL_ROW_FIXED_ITEMS = [
  { id: 'num', selector: '.dsh-plg-num', why: '序号列（width:18px + flex:none ⇒ 不可压缩）' },
  { id: 'provider', selector: '.dsh-plg-select-provider', why: '厂家选择器（定宽 100px 不收缩）' },
  { id: 'reason', selector: '.dsh-plg-select-reason', why: '思考档位（合并后的唯一思考控件，定宽 100px 不收缩）' },
];
// 图标组（⛓ ↑ ↓ ✕）：个数来自源码结构（GEOLOCK-B4 核），宽度来自 CSS（.dsh-plg-btn-icononly 的 min-width）。
const MODEL_ROW_ICON_SELECTOR = '.dsh-plg-btn-icononly';
const MODEL_ROW_ICON_COUNT = 4;
// ⚠ 行内**唯一一处非 CSS 实读值**：失效行的 ⚠ 徽标（.dsh-plg-badge-invalid）在 styles.js 里
//   **没有任何规则**（本轮 grep 实得 0 条）⇒ 它的宽由内容定（源码里内容就是单个 ⚠ 字形）。
//   本锁按「13px 字号下的单个字形 + 安全余量」取 20px 上界，并在报告 §⑨ 登记为**未验证**——
//   ⛔ 不把它当 0（那会让最坏态漏算），也不假装它是 CSS 读出来的。
const MODEL_ROW_BADGE_BOUND_PX = 20;

/** 从 styles.js 里取某条**简单选择器**规则的声明体；取不到返回 null（fail-closed）。 */
function cssRule(stylesSrc, selector) {
  const key = "'" + selector + '{';
  const i = stylesSrc.indexOf(key);
  if (i < 0) return null;
  const j = stylesSrc.indexOf('}', i);
  if (j < i) return null;
  return stylesSrc.slice(i + key.length, j);
}
/** 取某条规则里某个声明的原始值（未解析）；无此声明返回 null。 */
function cssDecl(rule, prop) {
  const m = new RegExp('(?:^|;)' + prop + ':([^;}]+)').exec(rule || '');
  return m ? m[1].trim() : null;
}
/** 取 px 值；非 px（em/%/auto）⇒ null（调用方须 fail-closed，⛔ 不得按 0 处理）。 */
function cssPx(rule, prop) {
  const v = cssDecl(rule, prop);
  if (v === null) return null;
  const m = /^(-?\d+(?:\.\d+)?)px$/.exec(v);
  return m ? Number(m[1]) : null;
}
/** 解析 flex 简写为 {grow,shrink,basis}（缺省按 CSS 规范：0 1 auto）。 */
function cssFlex(rule) {
  const v = cssDecl(rule, 'flex');
  if (v === null) return { grow: 0, shrink: 1, basis: 'auto', raw: null };
  if (v === 'none') return { grow: 0, shrink: 0, basis: 'auto', raw: v };
  if (v === 'auto') return { grow: 1, shrink: 1, basis: 'auto', raw: v };
  const p = v.split(/\s+/);
  // `flex:1 1 0` 的 basis 是裸 `0`（= 0px）——归一化，否则"是否 0 基"的判断会因写法不同而飘
  const rawBasis = p[2] === undefined ? '0px' : p[2];
  const basis = /^0(px)?$/.test(rawBasis) ? '0px' : rawBasis;
  return {
    grow: Number(p[0]),
    shrink: p[1] === undefined ? 1 : Number(p[1]),
    basis: basis,
    raw: v,
  };
}

/**
 * 计算模型行的宽度预算（**纯函数**：喂 CSS 文本即可，便于内存变异自证）。
 * @param {string} stylesSrc 已解码的 src/client/styles.js 源码
 */
function modelRowBudget(stylesSrc) {
  const rowRule = cssRule(stylesSrc, '.dsh-plg-row');
  if (rowRule === null) return { ok: false, reason: '缺 .dsh-plg-row 规则' };
  if (/flex-wrap\s*:/.test(rowRule)) {
    return { ok: false, reason: '.dsh-plg-row 出现了 flex-wrap ⇒ 本预算的"单行"前提不成立' };
  }
  const gap = cssPx(rowRule, 'gap');
  if (gap === null) return { ok: false, reason: '.dsh-plg-row 的 gap 不是 px（无法算间隙预算）' };
  const baseSelect = cssRule(stylesSrc, '.dsh-plg-select');
  const baseMin = cssPx(baseSelect, 'min-width');
  const items = [];
  for (const spec of MODEL_ROW_FIXED_ITEMS) {
    const rule = cssRule(stylesSrc, spec.selector);
    if (rule === null) return { ok: false, reason: '缺规则 ' + spec.selector };
    const flex = cssFlex(rule);
    const ownMin = cssPx(rule, 'min-width');
    // 专属规则未写 min-width 时会**继承**基规则 .dsh-plg-select 的 min-width（CSS 级联事实）
    const minW = ownMin !== null ? ownMin : (spec.selector.indexOf('.dsh-plg-select-') === 0 ? baseMin : null);
    const width = cssPx(rule, 'width');
    // 不可压缩（shrink:0）时宽度的**实际下限** = max(min-width, width)
    const widthFloor = flex.shrink === 0 && width !== null ? width : null;
    const candidates = [minW, widthFloor].filter((x) => x !== null && x !== undefined);
    if (candidates.length === 0) return { ok: false, reason: spec.selector + ' 既无 min-width 也无可继承的基规则下限' };
    items.push({
      id: spec.id, selector: spec.selector, floor: Math.max.apply(null, candidates),
      minW: minW, width: width, flex: flex, why: spec.why,
    });
  }
  const iconRule = cssRule(stylesSrc, MODEL_ROW_ICON_SELECTOR);
  if (iconRule === null) return { ok: false, reason: '缺规则 ' + MODEL_ROW_ICON_SELECTOR };
  const iconRowBtn = cssRule(stylesSrc, '.dsh-plg-row > .dsh-plg-btn');
  const iconMin = cssPx(iconRule, 'min-width');
  const iconFlex = cssFlex(iconRowBtn);
  if (iconMin === null) return { ok: false, reason: '图标按钮无 px min-width（宽度不可算）' };
  if (iconFlex.shrink !== 0) return { ok: false, reason: '行内按钮须 flex:none（可压缩 ⇒ 图标会被裁）' };
  const icons = { count: MODEL_ROW_ICON_COUNT, each: iconMin, floor: MODEL_ROW_ICON_COUNT * iconMin, flex: iconFlex };
  // 弹性项 = 模型名选择器
  const modelRule = cssRule(stylesSrc, '.dsh-plg-select-model');
  if (modelRule === null) return { ok: false, reason: '缺规则 .dsh-plg-select-model' };
  const modelFlex = cssFlex(modelRule);
  const modelOwnMin = cssPx(modelRule, 'min-width');
  const modelFloor = modelOwnMin !== null ? modelOwnMin : baseMin;
  if (modelFloor === null) return { ok: false, reason: '模型名选择器无下限' };
  // 子项数（**最坏态**：失效徽标在位 + 思考开关/等级在位）
  const childMax = items.length + 1 /* 模型名选择器 */ + icons.count + 1 /* 失效徽标（条件渲染） */;
  const fixedSum = items.reduce((a, x) => a + x.floor, 0) + icons.floor
    + gap * (childMax - 1) + MODEL_ROW_BADGE_BOUND_PX;
  return {
    ok: true, items: items, icons: icons, gap: gap, childMax: childMax,
    fixedSum: fixedSum, modelFloor: modelFloor, modelFlex: modelFlex,
    elastic: MODEL_ROW_AVAILABLE_PX - fixedSum,
  };
}

test('GEOLOCK-B1 模型行 = 单行 flex + gap 可算（"合计 ≤ 可用宽"的前提）', () => {
  const styles = stylesBody();
  const rowRule = cssRule(styles, '.dsh-plg-row');
  assert.ok(rowRule !== null, '前置：styles.js 须有 .dsh-plg-row 规则');
  assert.ok(/display:\s*flex/.test(rowRule), '模型行须是 flex 容器');
  assert.equal(/flex-wrap\s*:/.test(rowRule), false,
    '⛔ .dsh-plg-row 不得出现 flex-wrap —— 一旦换行，"固定宽合计 ≤ 可用宽"就不再是单行约束'
    + '（换行会把横向溢出变成"看不出来的第二行"，而历史形态正是横向溢出裁切）');
  const gap = cssPx(rowRule, 'gap');
  assert.ok(gap !== null && gap > 0, '间隙须是 px 且 > 0（否则预算少算 N 段间隙）；实得 ' + cssDecl(rowRule, 'gap'));
});

test('GEOLOCK-B2 固定宽项逐项列出，且「固定合计 + 模型名下限」≤ 真机可用宽', () => {
  const styles = stylesBody();
  const b = modelRowBudget(styles);
  assert.ok(b.ok, '预算须可算：' + b.reason);
  const listing = b.items.map((x) => x.id + '=' + x.floor).join(' · ');
  assert.equal(b.items.length, 3, '固定宽项须恰为 3 项（reason / provider / num）；实得 ' + b.items.length);
  for (const need of ['reason', 'provider', 'num']) {
    assert.ok(b.items.some((x) => x.id === need), '固定宽项清单缺 ' + need);
  }
  assert.ok(b.icons.floor > 0, '图标组固定宽须 > 0');
  // ① 固定合计（含图标组、间隙、失效徽标上界）本身不得越过可用宽
  assert.ok(b.fixedSum <= MODEL_ROW_AVAILABLE_PX,
    '固定宽合计 ' + b.fixedSum + 'px 已超真机可用宽 ' + MODEL_ROW_AVAILABLE_PX + 'px（' + listing
    + ' + 图标组 ' + b.icons.count + 'x' + b.icons.each + '=' + b.icons.floor
    + ' + 间隙 ' + b.gap + 'x' + (b.childMax - 1) + ' + 失效徽标上界 ' + MODEL_ROW_BADGE_BOUND_PX + '）');
  // ② 更要紧的一条：把**弹性项自己的下限**也算进去后仍不得越界（否则最压缩态照样溢出）
  assert.ok(b.fixedSum + b.modelFloor <= MODEL_ROW_AVAILABLE_PX,
    '固定合计 ' + b.fixedSum + ' + 模型名下限 ' + b.modelFloor + ' = ' + (b.fixedSum + b.modelFloor)
    + 'px > ' + MODEL_ROW_AVAILABLE_PX + 'px（最压缩态仍溢出）');
});

test('GEOLOCK-B3 模型名选择器是行内**唯一弹性项**（它吃掉全部剩余空间）', () => {
  const styles = stylesBody();
  const b = modelRowBudget(styles);
  assert.ok(b.ok, '预算须可算：' + b.reason);
  // ① 弹性项 = flex-grow ≥ 1 且 basis 为 0（剩余空间全给它，不是按内容宽参与分配）
  assert.ok(b.modelFlex.grow >= 1, '模型名选择器须 flex-grow ≥ 1（唯一弹性项）；实得 flex:' + b.modelFlex.raw);
  assert.equal(b.modelFlex.basis, '0px', '模型名选择器须 flex-basis 0（吃掉全部剩余空间）；实得 flex:' + b.modelFlex.raw);
  // ② 其余行内项一律不得 grow（多一个弹性项 ⇒ 剩余空间被分走，模型名不再吃满）
  const growers = b.items.filter((x) => x.flex.grow > 0).map((x) => x.id);
  assert.deepEqual(growers, [], '除模型名选择器外，行内不得有其它 grow 项；实得 ' + JSON.stringify(growers));
  assert.equal(b.icons.flex.grow, 0, '图标组不得 grow（须 flex:none）');
  // ③ 因果落点：留给弹性项的空间必须**不小于它的可读下限**
  assert.ok(b.elastic >= b.modelFloor,
    '留给模型名选择器的剩余空间 ' + b.elastic + 'px < 其下限 ' + b.modelFloor + 'px'
    + '（= 上一批修复的因果反向：弹性项被压到下限以下 ⇒ 名称被裁）');
});

test('GEOLOCK-B4 行内子项清单 = 本预算的分母（多出/少一项都会让预算失真）', async () => {
  const row = await codeOf('src/client/domains/settings/fallback-row.cjs');
  // 图标组：4 个（⛓ ↑ ↓ ✕）
  const icons = (row.match(/dsh-plg-btn dsh-plg-btn-icononly/g) || []).length;
  assert.equal(icons, MODEL_ROW_ICON_COUNT,
    '行内图标按钮个数须为 ' + MODEL_ROW_ICON_COUNT + '（预算按此算图标组宽）；实得 ' + icons);
  // 四个选择器各一个（品种在，且没多塞第二个同类控件）
  for (const cls of ['dsh-plg-select-provider', 'dsh-plg-select-model', 'dsh-plg-select-reason']) {
    const n = (row.match(new RegExp(cls, 'g')) || []).length;
    assert.equal(n, 1, '行内 ' + cls + ' 须恰 1 处；实得 ' + n);
  }
  // ⚠ 行内选择器**不得**再带 ms-fill / ms-content（这两类会覆盖 flex 简写，
  //   把上面对 flex 的读取变成假读数 ⇒ 预算数字不再代表真实占位）
  assert.equal(/dsh-plg-ms-(fill|content)/.test(row), false,
    '⛔ 行内选择器不得带 dsh-plg-ms-fill / dsh-plg-ms-content（会覆盖 flex ⇒ 预算失真）');
  // 失效徽标（预算里那 20px 上界的对象）必须在位——它若被删，B2 的上界就该同步下调。
  //   ⚠ 2026-10-19（清债批 D-2）：该节点原先挂的 `dsh-plg-badge-invalid` 是**孤儿类**
//     （styles 模块全文零规则）⇒ 类名已换成既有 `.dsh-plg-upd-outdated`（告警色），
  //     **节点本身与 `⚠` 字形、title 一字未动**。本断言据此改判**节点在不在**（沿用"失效徽标在位"
  //     这一语义），⛔ 不再绑定那个已退役的类名——否则锁会把"删孤儿类"判成"删了徽标"（假红）。
  assert.equal((row.match(/className: 'dsh-plg-upd-outdated', title: t\('cfgRowInvalid'\)/g) || []).length, 1,
    '前置：失效徽标节点须仍在位（预算为它留了 20px 上界）');
});

test('GEOLOCK-B5 真机可用宽只以**具名常量**出现一次（⛔ 不许散落魔数）+ 来源与装置互算', async () => {
  const fs = require('node:fs');
  const self = fs.readFileSync(__filename, 'utf8');
  // ① 剥注释后统计该**数字字面量**的出现次数（注释里引用来源不算"散落"）。
  //   ⚠ 正则用常量**动态拼**，不在本文件里再写一遍数字 —— 否则这条自检会把自己的判据算成散落点。
  const { codeOnly } = await import('../scripts/lib/code-only.mjs');
  const codeText = codeOnly(self);
  const literalRe = new RegExp('(?<![0-9.])' + MODEL_ROW_AVAILABLE_PX + '(?![0-9.])', 'g');
  const hits = (codeText.match(literalRe) || []).length;
  assert.equal(hits, 1,
    '该数字在**代码面**须恰出现 1 次（= MODEL_ROW_AVAILABLE_PX 的定义处）；实得 ' + hits);
  // ② 产品源码里**一次都不许有**（它是宿主给的边界，不是插件可以自行断言的像素值）
  const { listChunkFiles } = require('../scripts/lib/chunk-decode.mjs');
  const productHits = [];
  for (const rel of listChunkFiles(ROOT)) {
    if ((codeOnly(decodeChunk(rel)).match(literalRe) || []).length > 0) productHits.push(rel);
  }
  // 目标模式：业务已全部是普通模块 ⇒ chunk 面允许为 0。
  // 该判据仍以「0 命中」为通过条件；chunk 面存在时逐件检查。
  assert.deepEqual(productHits, [],
    '⛔ 产品源码的**代码面**不得出现该数字（散落魔数）；命中 ' + JSON.stringify(productHits)
    + '｜判据范围 = src/client/** + src/host/** 全部 chunk 的剥注释代码面（不含注释文本）');
  // ② 与量测装置**互算**（不是把 534 再抄一遍）：装置的注释写明 row1 = root - 30、root 564 → row1 534
  const driver = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'settings-layout-driver.mjs'), 'utf8');
  const chain = /row1 = root - (\d+)/.exec(driver);
  assert.ok(chain, '装置须仍写明 row1 = root - N 的偏移链');
  const pair = /root (\d+) → row1 (\d+)/.exec(driver);
  assert.ok(pair, '装置注释须仍写明 root → row1 的实测值对');
  assert.equal(Number(pair[1]) - Number(chain[1]), Number(pair[2]), '装置的 root - 偏移须等于其 row1 读数');
  assert.equal(MODEL_ROW_AVAILABLE_PX, Number(pair[2]),
    '具名常量须等于装置注释里那条实测链的 row1 读数；实得 ' + MODEL_ROW_AVAILABLE_PX + ' vs ' + pair[2]);
  // ③ 来源注释必须写明三条实测依据（缺一条就等于"来源不明"）。
  //   ⚠ 锚串里那段数字由常量拼入（避免本文件把该数字再写第二遍 ⇒ 上面的"只出现一次"自检才有意义）
  const head = self.slice(0, self.indexOf('const MODEL_ROW_AVAILABLE_PX'));
  const N = String(MODEL_ROW_AVAILABLE_PX);
  for (const anchor of ['CHG-196', 'settings-layout-driver.mjs:191', '586 vs clientWidth ' + N]) {
    assert.ok(head.indexOf(anchor) >= 0, '来源注释缺依据锚：' + anchor);
  }
});

test('GEOLOCK-B-V 变异自证：provider 下限回 104 ⇒ B2/B3 必红（锁 B 有牙）+ 历史形态复算 + 负控', () => {
  const styles = stylesBody();
  const current = modelRowBudget(styles);
  assert.ok(current.ok, '前置：当前树预算须可算：' + current.reason);
  const provider = current.items.find((x) => x.id === 'provider');
  // 2026-11-14（模型行统一批）：厂家列不再可收缩，定宽 100px（与档位列同值）。
  assert.equal(provider.floor, 100, '前置：当前 provider 下限须为 100px（定宽不收缩）；实得 ' + provider.floor);
  const reasonItem = current.items.find((x) => x.id === 'reason');
  assert.equal(reasonItem.floor, 100, '前置：当前 reason 下限须为 100px（与 provider 同值）；实得 ' + reasonItem.floor);

  // ⭐ 变异②（作业书判据 A 的第二条）：provider 的 min-width 由 80 调回**上一次的溢出配置** 104
  //   —— 逐字来自 ed96df2^ 的 .dsh-plg-select-provider{…min-width:104px…}。
  // ⚠ 2026-11-14（模型行统一批）重锚：provider 已是定宽 100，旧锚点（136/80/104）全部失效。
  //   改用**档位列**做变异对象——把它放宽到 128（= 上一版参考图的值），这正是「改回那版会溢出」的等价证明。
  const mutated = styles.replace(
    "'.dsh-plg-select-reason{flex:0 0 100px;width:100px;min-width:100px}'",
    "'.dsh-plg-select-reason{flex:0 0 128px;width:128px;min-width:128px}'");
  assert.notEqual(mutated, styles, '前置：变异②锚点须命中（reason 的定宽声明）');
  const after = modelRowBudget(mutated);
  assert.ok(after.ok, '前置：变异后预算仍须可算');
  assert.equal(after.items.find((x) => x.id === 'reason').floor, 128, '前置：变异后 reason 下限应为 128');
  // ⇒ B2 第二段（含弹性项下限的那条）必红。
  //   ⚠ 如实声明**哪一段**会红：仅把 provider 下限调回 104（+24px）时，**第一段**
  //   （"固定宽合计本身" 396→420 ≤ 534）仍为真 ⇒ 本变异打红的是 B2 的**第二段**与 B3。
  //   ⛔ 不写成"两段都红"，那是把判据读数说错（本仓方法学：读数与事实必须同向）。
  assert.equal(after.fixedSum <= MODEL_ROW_AVAILABLE_PX, true,
    '变异②后固定合计 ' + after.fixedSum + ' 仍未越界（如实记录：本变异打红的是含弹性项下限的那一段）');
  assert.equal(after.fixedSum + after.modelFloor <= MODEL_ROW_AVAILABLE_PX, false,
    '变异②后 GEOLOCK-B2 第二段必红：' + (after.fixedSum + after.modelFloor) + ' > ' + MODEL_ROW_AVAILABLE_PX);
  // ⇒ B3 的因果断言也必红（弹性项被压到下限以下）
  assert.equal(after.elastic >= after.modelFloor, false,
    '变异②后 GEOLOCK-B3 第三段必红：剩余 ' + after.elastic + ' < 下限 ' + after.modelFloor);

  // ⭐ 「合并成一项」的价值 —— ⚠⚠ 2026-11-17 第二轮体检**删掉了一条恒真判据**：
  //   原先是 `const mergedSaving = 56 + 62 - 100 + 8; assert.equal(mergedSaving, 26)` ——
  //   这是**纯常量算术**，不含任何产品输入：把 CSS 改成任何值它都照绿，
  //   既不证明「合并真的省了宽度」，也不证明「省了 26px」。属 regression-hunter 点名的
  //   「判据改浅」形态（重锚时把真机标定降级成了自证式算式）。
  //   ⇒ 现改为**两条对真实解析结果的断言**（数据全部来自 modelRowBudget(styles) 的解析）：
  //     ① 固定项合计必须等于各项下限之和（证明预算确实在按 CSS 累加，不是拍出来的数）；
  //     ② 当前行总需求必须落进可用宽（证明「溢出已被消除」这条结论仍成立）。
  //   ⚠ 历史标定（56 + 62 − 100 + 8 = 26px）仅作**背景记录**保留在注释里，⛔ 不再作为断言：
  //     那两个宽度来自已被删除的 thinking/level 控件，现在无法从 CSS 取回，
  //     断言它们等于常数只是在自我复述。
  // 预算的固定合计 = 各子项下限 + 图标组下限 + (子项数−1) 段间隙 + 失效徽标占位。
  // 逐项复算一遍，证明 fixedSum 确实是**按解析结果累加**出来的（而不是写死的常数）。
  // ⚠ 注意作用域：本用例里 `after` 是**变异后**（故意溢出）的预算 ⇒ 只对**未变异的 current**
  //   做「必须装得下」的断言；composition 恒等式对两者都成立，故两处都验一遍。
  const sumOf = (b) => b.items.reduce(function (n, it) { return n + it.floor; }, 0)
    + b.icons.floor + b.gap * (b.childMax - 1) + MODEL_ROW_BADGE_BOUND_PX;
  assert.equal(current.fixedSum, sumOf(current),
    '未变异态：固定项合计必须等于「子项下限 + 图标 + 间隙 + 徽标占位」的逐项和（实得 '
    + current.fixedSum + ' vs 求和 ' + sumOf(current) + '）');
  assert.equal(after.fixedSum, sumOf(after),
    '变异态：同一恒等式仍须成立（实得 ' + after.fixedSum + ' vs 求和 ' + sumOf(after) + '）');
  assert.ok(current.fixedSum + current.modelFloor <= MODEL_ROW_AVAILABLE_PX,
    '未变异态：行总需求（' + (current.fixedSum + current.modelFloor) + '）必须 ≤ 可用宽 '
    + MODEL_ROW_AVAILABLE_PX + ' ⇒ 溢出已消除（这是 GEOLOCK-B2 的核心结论，此处独立复算一次）');

  // ⭐⭐ **标定**（本锁最关键的一条自证）：当前树的「全部子项下限 + 间隙」必须落进可用宽，
  //   且**余量恰为**上面算出的释放量的一半上下 —— 一句话：溢出是被消除的，不是被口径藏起来的。
  //   ⚠ 子项数 = 序号 + 3 选择器 + 4 图标 = 8 个 ⇒ 间隙 7 段（失效徽标那一段另算，见 B2）。
  const rawSum = (b) => b.items.reduce((a, x) => a + x.floor, 0) + b.modelFloor
    + b.icons.floor + b.gap * (b.childMax - 1);
  assert.ok(rawSum(current) <= MODEL_ROW_AVAILABLE_PX,
    '当前树的「全部下限 + 间隙」须 ≤ 可用宽；实得 ' + rawSum(current));

  // 负控：不动任何文件 ⇒ 当前读数干净（防"恒红"）
  assert.ok(current.fixedSum + current.modelFloor <= MODEL_ROW_AVAILABLE_PX,
    '负控：当前树 ' + (current.fixedSum + current.modelFloor) + ' <= ' + MODEL_ROW_AVAILABLE_PX);
});

// ═══════════════════════════════════════════════════════════════════════════
// PE-05-G6 补齐之二（2026-11-17 · 全功能审查）：**height 断言**
// ═══════════════════════════════════════════════════════════════════════════
// 病历：`grep -c height test/layout-geometry-lock.test.cjs` = **0** ⇒ 本文件此前只锁宽度，
//   而「三套高度归一 32px」（2026-11-14 批的核心改动）**零断言**。任何人把 height 改回
//   40/27/43，本锁全绿。
// 判据：逐个组件类断言其 CSS 声明里有 `height:32px`（或声明的目标值）+ `box-sizing:border-box`
//   （后者是「32 真的是外框高」的前提，缺了它会随 padding 变大）。
//   ⚠ 只判**声明值**（成因面），不判运行期像素——后者归 settings-layout-audit。
test('PE05-HEIGHT 三套高度归一：下拉/输入/单元格/图标按钮均声明 height:32px + border-box', () => {
  const { stylesBody } = require('./helpers/client-styles.cjs');
  const css = stylesBody();
  const must32 = ['.dsh-plg-select', '.dsh-plg-input', '.dsh-plg-btn-cell', '.dsh-plg-btn-icononly'];
  for (const cls of must32) {
    const re = new RegExp('\\' + cls + '\\s*\\{[^}]*\\}');
    const m = css.match(re);
    assert.ok(m, cls + ' 必须有 CSS 声明块（找不到 ⇒ 判据无被测物，不得静默跳过）');
    assert.match(m[0], /height:\s*32px/, cls + ' 必须声明 height:32px（三套高度归一的核心）');
    assert.match(m[0], /box-sizing:\s*border-box/, cls + ' 必须声明 box-sizing:border-box（否则 32 不是外框高）');
  }
  // 负控：确认判据有牙 —— 若把某个类的高度改成别的值，上面的正则必须不再命中
  const mutated = css.replace(/(\.dsh-plg-select\s*\{[^}]*?)height:\s*32px/, '$1height:40px');
  assert.notEqual(mutated, css, '变异必须真的改到 CSS（否则本判据的自证无效）');
  const mSel = mutated.match(/\.dsh-plg-select\s*\{[^}]*\}/);
  assert.ok(!/height:\s*32px/.test(mSel[0]), '变异后该类的 height:32px 必须不再命中（判据有牙）');
});

