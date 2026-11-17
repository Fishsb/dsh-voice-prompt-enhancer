'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// 纠错参考档位的**接线**回归锁（2026-11-17 · 用户报「新加的档位无法选择」）
//
// 病历（真实故障）：把下拉从 4 档扩到 7 档（关 / 无参考 / 1–5 轮会话）后，用户选中任何新档位
//   都会**立刻弹回 1 轮**。宿主侧实测是好的（config/set 写 0 / 4 / 5 都原样读回），
//   坏在客户端两处：
//     ① `app.cjs` 的 `createVoiceSection` deps **根本没接** `normalizeCorrectionWindowRounds`；
//     ② `section.cjs` 的**兜底实现**还停在 chunk 时代的旧区间 `(n === 2 || n === 3) ? n : 1`。
//   两者叠加 ⇒ 选 4 → 归一成 1 → 写回配置 → 界面重新渲染成「1轮会话」。
//
// 为什么原有测试全绿：HCR-06 判的是**宿主**的 `resolveCorrectionWindow`，而故障在**客户端接线**；
//   宿主与客户端本来就各有一份归一，判据只锁了其中一份。
//
// 判据（三条互补，缺一即可能复发）：
//   CWU-A **接线**：`app.cjs` 必须把 `normalizeCorrectionWindowRounds` 传进 createVoiceSection
//   CWU-B **兜底区间**：section.cjs 的兜底实现必须接受 0–5（不得窄化为旧的 2/3）
//   CWU-C **档位齐备**：7 档 = off / none / 1..5，且 pick 处理器把 none 写 0
//   CWU-V 变异自证：把接线删掉 ⇒ CWU-A 必红；把兜底改回 2/3 ⇒ CWU-B 必红
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// 取「createVoiceSection({ ... })」的依赖对象文本（按花括号配平）。
function voiceSectionDeps(src) {
  const i = src.indexOf('createVoiceSection({');
  assert.ok(i >= 0, 'app.cjs 必须存在 createVoiceSection({ 调用');
  const open = src.indexOf('{', i);
  let depth = 0;
  for (let k = open; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') { depth--; if (depth === 0) return src.slice(open, k + 1); }
  }
  return null;
}

test('CWU-A 接线：app.cjs 必须把 normalizeCorrectionWindowRounds 传进 createVoiceSection', () => {
  const deps = voiceSectionDeps(read('src/client/app.cjs'));
  assert.ok(deps !== null, '必须能按花括号配平取出 createVoiceSection 的依赖对象');
  assert.ok(/normalizeCorrectionWindowRounds\s*:/.test(deps),
    'createVoiceSection 的 deps 必须含 normalizeCorrectionWindowRounds —— 否则 section.cjs 的 typeof 守卫取不到，'
    + '会退回兜底实现，新档位被静默折回 1 轮（这就是「选不中」的根因）');
  assert.ok(/normalizeCorrectionWindowRounds\s*:\s*contracts\.normalizeCorrectionWindowRounds/.test(deps),
    '应当注入契约层的实现（contracts.normalizeCorrectionWindowRounds），而不是本地再造一份');
});

test('CWU-B 兜底区间：section.cjs 的兜底归一必须接受 0–5', () => {
  const src = read('src/client/domains/voice/section.cjs');
  const i = src.indexOf('const normalizeCorrectionWindowRounds');
  assert.ok(i >= 0, 'section.cjs 必须声明 normalizeCorrectionWindowRounds');
  const tail = src.slice(i, i + 700);
  // 取出兜底函数体（三目里的 function 分支）
  const m = tail.match(/: function \(n\) \{([\s\S]*?)\};/);
  assert.ok(m !== null, '必须能定位兜底实现（形如 : function (n) { ... };）');
  const body = m[1];
  // 行为断言：把兜底函数真的求值一遍，逐值验 —— 比正则更硬。
  const fn = new Function('n', body);
  for (const n of [0, 1, 2, 3, 4, 5]) {
    assert.equal(fn(n), n, '兜底归一必须原样接受 ' + n + '（实得 ' + fn(n) + '）');
  }
  for (const bad of [6, -1, 1.5, '4', null, undefined]) {
    assert.equal(fn(bad), 1, '兜底归一遇到非法值 ' + JSON.stringify(bad) + ' 须回落 1（实得 ' + fn(bad) + '）');
  }
  assert.equal(/n === 2 \|\| n === 3/.test(body), false,
    '⛔ 兜底不得停留在旧区间 (n === 2 || n === 3) —— 那会把 0/1/4/5 全部折回');
});

test('CWU-C 档位齐备：7 档 = 关 / 无参考 / 1–5 轮会话，且「无参考」写 windowRounds 0', () => {
  const src = read('src/client/domains/voice/section.cjs');
  // ① 上界常量必须为 5（1–5 轮会话 + 2 个非数值档 = 7）
  const m = src.match(/const CORRECTION_WINDOW_MAX = (\d+);/);
  assert.ok(m !== null, '必须有 CORRECTION_WINDOW_MAX 常量（档位上界的单一事实源）');
  assert.equal(Number(m[1]), 5, '参考轮数上界须为 5（扩档后的契约）；实得 ' + m[1]);
  // ② 两个非数值档
  assert.ok(/value: 'off'/.test(src), '必须有「关」档');
  assert.ok(/value: 'none'/.test(src), '必须有「无参考」档（value=none）');
  // ③ pick 处理器：「无参考」= 开启 + windowRounds 0（⛔ 不是 enabled:false）
  assert.match(src, /if \(raw === 'none'\) \{ saveVoiceCfg\(\{ correction: \{ enabled: true, windowRounds: 0 \} \}\); return; \}/,
    '「无参考」必须写 enabled:true + windowRounds:0（它是开启纠错、只是不读历史，不是关）');
  // ④ 当前值映射：0 ⇒ 'none'（否则会渲染成选中「关」）
  assert.match(src, /windowRoundsNow === 0 \? 'none' : String\(windowRoundsNow\)/,
    '当前值映射必须把 0 映射到 none 档，否则「无参考」永远显示不成选中态');
});

test('CWU-V 变异自证：删接线 / 窄化兜底 都必须被本文件判红', () => {
  const appSrc = read('src/client/app.cjs');
  const secSrc = read('src/client/domains/voice/section.cjs');
  // 变异①：把 app.cjs 里那行接线删掉
  const appMut = appSrc.replace(/\s*normalizeCorrectionWindowRounds\s*:\s*contracts\.normalizeCorrectionWindowRounds,/, '');
  assert.notEqual(appMut, appSrc, '前置：变异①锚点须命中（否则自证无效）');
  const depsMut = voiceSectionDeps(appMut);
  assert.equal(/normalizeCorrectionWindowRounds\s*:/.test(depsMut), false,
    '变异①后 deps 里不应再有该键（这段自证 CWU-A 的判据面确实覆盖了 deps 对象）');
  // 变异②：把兜底改回旧区间
  const secMut = secSrc.replace(
    /: function \(n\) \{ return \(Number\.isInteger\(n\) && n >= 0 && n <= 5\) \? n : 1; \};/,
    ': function (n) { return (n === 2 || n === 3) ? n : 1; };');
  assert.notEqual(secMut, secSrc, '前置：变异②锚点须命中');
  assert.equal(/n === 2 \|\| n === 3/.test(secMut), true, '变异②后应回到旧区间（CVU-B 会因此判红）');
});
