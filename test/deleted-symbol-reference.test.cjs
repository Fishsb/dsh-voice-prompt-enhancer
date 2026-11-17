'use strict';
// deleted-symbol-reference.test —— 「删了定义、忘了删调用」的回归锁
//
// 病历（2026-11-17 · 第二轮体检，由 voice-auditor 与 docs-auditor 独立发现）：
//   PE-39 清理"死判据"时删掉了 `stallTailCv` 的**定义**，但它的**调用点**仍留在
//   `official-bridge.cjs:1001`（"取样门卡死兜底"的守卫条件里）。后果：
//     · 该调用被外层 `try { … } catch { /* 单帧失败忽略 */ }` 吞掉 ⇒ **无任何可见报错**；
//     · 整段兜底 100% 不可达；
//     · tick 在读数出账前中断 ⇒ vad* 读数冻结、判停检查被跳过（每秒 10 次异常）。
//   ⚠ 而当时 **1023 条测试全绿** —— 因为没有任何用例驱动那条真实路径，
//     也没有任何判据检查"被删的符号是否仍被引用"。
//
// 本锁填的正是这个空档：**对每个被改动文件，取 diff 前后的声明面，
//   若某符号在新版本里已无声明、却仍有 `name(` 形式的调用 ⇒ 必红。**
//
// ⚠ 基准写法（刻意的）：本文件**不使用任何浮动 ref 字面量**——
//   提交点一律由 `git log -N --format=%H` **运行时解析成具体 sha** 后再用。
//   理由：把 `HEAD` 当基准会让"提交后基准就变成修好形态"，判据随之恒绿或恒红
//   （`test/mutation-ref-lock.test.cjs` 的 MRL-3 会把这种写法判红）。
//
// 判据边界（如实写明）：
//   · 只判**顶层声明**（`function X` / `const X` / `let X` / `var X`，行首）。
//     块内局部变量、解构绑定、import 名**不在判据面**（它们不会因"删定义"而悬空成 ReferenceError）。
//   · 只判**调用形态** `name(`（排除 `obj.name(` 成员调用）。
//   · 注释不剥离 ⇒ 注释里出现被删符号的调用形态会**误报**（宁严不松：误报只让人删一行注释）。
//   · 无 git / 浅克隆（`git log` 取不到两个提交）⇒ 跳过并**显式打印 SKIP 原因**，不静默判绿。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

function git(args) {
  const r = spawnSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? (r.stdout || '') : null;
}

/** 取最近 n 个提交的 sha（新→旧）。无 git / 浅克隆返回 null。 */
function recentCommits(n) {
  const out = git(['log', '-n', String(n), '--format=%H']);
  if (out === null) return null;
  const list = out.split('\n').map((s) => s.trim()).filter(Boolean);
  return list.length >= n ? list : null;
}

/** 顶层声明面（见文件头"判据边界"第 1 条）。 */
function declaredOf(src) {
  const out = new Set();
  for (const m of src.matchAll(/^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) out.add(m[1]);
  for (const m of src.matchAll(/^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) out.add(m[1]);
  return out;
}

/** 找出"新版本已无声明、但仍被调用"的符号。 */
function staleRefs(beforeSrc, afterSrc) {
  const before = declaredOf(beforeSrc);
  const after = declaredOf(afterSrc);
  const removed = [...before].filter((n) => !after.has(n));
  const hits = [];
  for (const name of removed) {
    const re = new RegExp('(?<![.\\w$])' + name.replace(/\$/g, '\\$') + '\\s*\\(');
    if (re.test(afterSrc)) hits.push(name);
  }
  return hits;
}

test('DSR-01 最近一次提交不得"删定义留调用"（stallTailCv 病历的形态）', () => {
  const commits = recentCommits(2);
  if (commits === null) {
    console.log('SKIP | DSR-01 | 取不到最近 2 个提交（浅克隆或首个提交）—— 不静默判绿');
    return;
  }
  const [tip, parent] = commits;
  const files = (git(['diff', '--name-only', parent + '..' + tip]) || '')
    .split('\n').filter((f) => /\.(cjs|js)$/.test(f));
  const stale = [];
  let checked = 0;
  for (const f of files) {
    const before = git(['show', parent + ':' + f]);
    const after = git(['show', tip + ':' + f]);
    if (before === null || after === null) continue;   // 新增 / 删除的文件：不构成"删定义留调用"
    checked += 1;
    for (const name of staleRefs(before, after)) stale.push({ file: f, name });
  }
  // ⚠ 2026-11-17 订正（本轮自查）：本断言原写「必须至少扫到 1 个被改动的 .cjs/.js」，
  //   但**纯文档提交**（只改 CHANGELOG.md）本就该有 0 个代码文件 ⇒ 会把合法提交判红。
  //   判据的真实意图是「**有候选却全被跳过**时不得静默判绿」，不是「每次提交都必须改代码」。
  //   ⇒ 只在「候选 > 0 而实扫 = 0」时红；候选 = 0 时显式 SKIP 并说明。
  if (files.length === 0) {
    console.log('SKIP | DSR-01 | 最近一次提交未改动 .cjs/.js（纯文档提交）—— 本判据无被测物');
    return;
  }
  assert.ok(checked > 0,
    '有 ' + files.length + ' 个候选 .cjs/.js 但**一个都没扫成**（全是新增/删除文件？）⇒ 判据无被测物，不得判绿');
  assert.deepEqual(stale, [],
    '发现"已删除但仍被调用"的符号：' + JSON.stringify(stale) +
    ' —— 这类调用会抛 ReferenceError，且若被 try/catch 包住会**静默失效**（PE-39 病历）');
});

test('DSR-02 未提交的工作区不得"删定义留调用"', () => {
  const commits = recentCommits(1);
  if (commits === null) {
    console.log('SKIP | DSR-02 | 取不到提交点（浅克隆）—— 不静默判绿');
    return;
  }
  const tip = commits[0];
  const changed = git(['diff', '--name-only', tip]);
  if (changed === null) {
    console.log('SKIP | DSR-02 | git diff 不可读');
    return;
  }
  const files = changed.split('\n').filter((f) => /\.(cjs|js)$/.test(f));
  if (files.length === 0) {
    console.log('SKIP | DSR-02 | 工作区无 .cjs/.js 改动');
    return;
  }
  const stale = [];
  for (const f of files) {
    const before = git(['show', tip + ':' + f]);
    if (before === null) continue;                      // 新增文件
    let after = null;
    try { after = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (e) { continue; }  // 被删除
    for (const name of staleRefs(before, after)) stale.push({ file: f, name });
  }
  assert.deepEqual(stale, [], '工作区里出现"已删除但仍被调用"的符号：' + JSON.stringify(stale));
});

test('DSR-03 判据自证：构造"删定义留调用"必须被识别（防恒绿）', () => {
  const before = 'function keepMe() { return 1; }\nfunction stallTailCv() { return 0; }\n';
  const after = 'function keepMe() { return 1; }\nif (x) { keepMe(); stallTailCv(); }\n';
  assert.deepEqual(staleRefs(before, after), ['stallTailCv'], '必须精确识别被删除且仍被调用的符号');
  // 负控：定义还在 → 不得误报
  const after2 = 'function keepMe() { return 1; }\nfunction stallTailCv() { return 0; }\nif (x) stallTailCv();\n';
  assert.deepEqual(staleRefs(before, after2), [], '定义仍在时不得误报');
  // 负控：只是成员调用 → 不得误报
  const after3 = 'function keepMe() { return 1; }\nobj.stallTailCv();\n';
  assert.deepEqual(staleRefs(before, after3), [], '成员调用 obj.x() 不在判据面（见文件头边界第 2 条）');
});
