#!/usr/bin/env node
/**
 * scripts/gen-ledger-index.mjs —— 账本索引重建入口（npm run gen:ledger）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么需要这个脚本（2026-11-09 · TSK-353）
 * ═══════════════════════════════════════════════════════════════════════════
 * 账本索引 ledger/units/index.toml 此前**只能被整份覆盖**，而覆盖路径上有两道守卫
 * 互相顶死：
 *   · 带旧单元 ⇒ ledger-duplicate-id（overwrite 也做「新内容 ∪ 盘上内容」的唯一性校验）
 *   · 不带旧单元 ⇒ shrinking（31468 字节 → 数百字节，低于缩水阈值）
 *   · 写 ledger/spec/units.toml ⇒ generated-write-denied，提示「运行 npm run gen:ledger」
 *     —— 而那个脚本此前**在本仓库不存在**
 * ⇒ 新单元写不进索引 ⇒ 派活门禁读不到需求 ⇒ 修索引的活也派不出去（bootstrap 死结）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 口径（为什么是「基线 + 增量」而不是「从 .md 全量重生成」）
 * ═══════════════════════════════════════════════════════════════════════════
 * 实测（2026-11-09）：TSK-346 / TSK-347 / TSK-349 三条单元**没有 .md 正文**，
 * 它们的 path_options / requirement_coverage / verify 等结构化字段
 * **只存在于 index.toml 本身**。⇒ 任何「扫 .md 全量重生成」的写法都会当场毁账。
 *
 * 本脚本因此采用：
 *   · **基线** = 现有 index.toml 的每一条 [[unit]] 块**逐字节原样保留**（顺序不动、块间
 *     分隔原样不动）—— 实现上用**字符偏移原地拼接**，不做「切块后重新渲染」，
 *     因为现文的块间分隔并不都是单个空行（实测重渲染会掉 6 个空行）。
 *   · **增量** = 扫描 ledger/units/*.md 里带标记的登记块（toml 围栏内的 [[unit]]），
 *     只在索引里**没有**该 id 时追加到文件末尾；若索引里已有同 id 且内容不同，
 *     按「源文件为准」**原地替换那一个块**（其余字节仍不动）。
 * ⇒ 新单元从此只需在 .md 正文末尾带一块登记块，再跑一次 npm run gen:ledger 即进索引。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 幂等
 * ═══════════════════════════════════════════════════════════════════════════
 * 操作是确定性的（追加用统一分隔、替换保留原尾部分隔）；连跑两次第二次 md5sum 必须相同。
 * --check 只读：重建结果与盘上逐字节相等 ⇒ exit 0，否则 exit 1（不改盘）。
 *
 * 用法：
 *   node scripts/gen-ledger-index.mjs              # 重建（写盘；有变化才备份）
 *   node scripts/gen-ledger-index.mjs --check      # 只校验是否已是最新
 *   node scripts/gen-ledger-index.mjs --ledger <账本区根>   # 显式指定账本区
 *   npm run gen:ledger                             # 同上（默认写盘）
 *
 * 退出码：0 = 已是最新 / 重建成功；1 = --check 发现漂移；2 = 用法或数据错误。
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, copyFileSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const FENCE_OPEN = '```toml';
const FENCE_CLOSE = '```';

function parseArgs(argv) {
  const out = { check: false, ledger: undefined, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--check') out.check = true;
    else if (a === '--ledger') { out.ledger = argv[i + 1]; i += 1; }
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error('未知参数：' + a);
  }
  return out;
}

/** 账本区根：--ledger > HOB_LEDGER_ROOT > <DSH_HOME>/hob-ledgers/<仓库目录名>。 */
function resolveLedgerRoot(explicit) {
  if (explicit) return resolve(explicit);
  if (process.env.HOB_LEDGER_ROOT) return resolve(process.env.HOB_LEDGER_ROOT);
  const dshHome = process.env.DSH_HOME || join(process.env.HOME || '', '.dsh');
  return join(dshHome, 'hob-ledgers', basename(REPO_ROOT));
}

/**
 * 按 [[unit]] 切块，**带字符偏移**：每块给出 [start, end)（end = 下一块起点或文末），
 * 并给出块内最后一行非空行之后的「尾部分隔原文」，替换时原样保留 ⇒ 其余字节零改动。
 */
function scanBlocks(text) {
  const lines = text.split('\n');
  const starts = [];
  const lineStarts = [];
  let offset = 0;
  for (const line of lines) {
    lineStarts.push(offset);
    // ⚠ 必须用**字符**偏移（JS 字符串下标），不是字节偏移 —— 索引里大量中文，
    //   用 Buffer.byteLength 累加会让 slice 切在字符中间，块边界全错。
    offset += line.length + 1;
  }
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() === '[[unit]]') starts.push({ lineIndex: i, charStart: lineStarts[i] });
  }
  const blocks = [];
  for (let k = 0; k < starts.length; k += 1) {
    const charStart = starts[k].charStart;
    const charEnd = k + 1 < starts.length ? starts[k + 1].charStart : text.length;
    const slice = text.slice(charStart, charEnd);
    const m = /^id\s*=\s*"([^"]*)"\s*$/m.exec(slice);
    if (m === null) throw new Error('index.toml 第 ' + (starts[k].lineIndex + 1) + ' 行起的 [[unit]] 块缺 id = "..."');
    // 尾部：从最后一个非空行结尾到块尾（通常是 "\n" 或 "\n\n"）
    const linesOfSlice = slice.split('\n');
    let lastNonBlank = linesOfSlice.length - 1;
    while (lastNonBlank >= 0 && linesOfSlice[lastNonBlank].trim() === '') lastNonBlank -= 1;
    const body = linesOfSlice.slice(0, lastNonBlank + 1).join('\n');
    const tail = slice.slice(body.length);
    blocks.push({ id: m[1], charStart, charEnd, body, tail, lineIndex: starts[k].lineIndex });
  }
  return blocks;
}

/** 形状校验：只收「字符串」与「字符串数组」（与写入面 ledger-unit-malformed 同口径）。 */
function validateBlockShape(lines, where) {
  const problems = [];
  let inArray = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (inArray) {
      if (line.startsWith(']')) inArray = false;
      else if (line !== '' && !/^".*",?$/.test(line)) problems.push(where + ' 第 ' + (i + 1) + ' 行：数组元素必须是字符串 → ' + line);
      continue;
    }
    if (line === '' || line === '[[unit]]' || line.startsWith('#')) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*\s*=\s*"([^"\\]|\\.)*"\s*$/.test(line)) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*\s*=\s*\[\s*$/.test(line)) { inArray = true; continue; }
    if (/^[A-Za-z_][A-Za-z0-9_]*\s*=\s*\[\s*\]\s*$/.test(line)) continue;
    problems.push(where + ' 第 ' + (i + 1) + ' 行：只收字符串 / 字符串数组 → ' + line);
  }
  if (inArray) problems.push(where + '：数组未闭合');
  return problems;
}

/** 扫一个 .md，取出所有 toml 围栏里含 [[unit]] 的登记块（按块切，去尾部空行）。 */
function fencedUnits(mdText, file) {
  const out = [];
  const lines = mdText.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() !== FENCE_OPEN) continue;
    let j = i + 1;
    while (j < lines.length && lines[j].trim() !== FENCE_CLOSE) j += 1;
    const body = lines.slice(i + 1, j);
    if (body.some((l) => l.trim() === '[[unit]]')) {
      const chunks = [];
      let cur = null;
      for (const l of body) {
        if (l.trim() === '[[unit]]') { if (cur) chunks.push(cur); cur = [l]; }
        else if (cur) cur.push(l);
      }
      if (cur) chunks.push(cur);
      for (const c of chunks) {
        const a = c.slice();
        while (a.length > 0 && a[a.length - 1].trim() === '') a.pop();
        out.push({ lines: a, file });
      }
    }
    i = j;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('用法：node scripts/gen-ledger-index.mjs [--check] [--ledger <账本区根>]');
    return 0;
  }
  const ledgerRoot = resolveLedgerRoot(args.ledger);
  const unitsDir = join(ledgerRoot, 'ledger', 'units');
  const indexPath = join(unitsDir, 'index.toml');
  if (!existsSync(indexPath)) {
    console.error('✗ 找不到索引正本：' + indexPath);
    return 2;
  }

  const before = readFileSync(indexPath, 'utf8');
  const blocks = scanBlocks(before);
  const baselineIds = blocks.map((b) => b.id);

  const mdFiles = readdirSync(unitsDir).filter((n) => n.endsWith('.md')).sort();
  const fenced = [];
  const shapeProblems = [];
  for (const name of mdFiles) {
    const text = readFileSync(join(unitsDir, name), 'utf8');
    for (const f of fencedUnits(text, name)) {
      shapeProblems.push(...validateBlockShape(f.lines, 'ledger/units/' + name));
      fenced.push(f);
    }
  }
  if (shapeProblems.length > 0) {
    console.error('✗ 登记块形状不合法（' + shapeProblems.length + ' 条）：');
    for (const p of shapeProblems.slice(0, 12)) console.error('  · ' + p);
    return 2;
  }

  const fencedById = new Map();
  for (const f of fenced) {
    const idLine = f.lines.find((l) => /^id\s*=\s*"/.test(l));
    const m = idLine === undefined ? null : /^id\s*=\s*"([^"]*)"\s*$/.exec(idLine);
    if (m === null) { console.error('✗ ledger/units/' + f.file + '：登记块缺 id = "..."'); return 2; }
    if (fencedById.has(m[1])) {
      console.error('✗ 登记块重复：' + m[1] + '（' + fencedById.get(m[1]).file + ' 与 ' + f.file + '）');
      return 2;
    }
    fencedById.set(m[1], { lines: f.lines, file: f.file });
  }

  // ① 替换：索引里已有同 id 且源块不同 ⇒ 原地替换该块正文，尾部分隔原样保留。
  const replacements = [];
  const updated = [];
  const used = new Set();
  for (const b of blocks) {
    const f = fencedById.get(b.id);
    if (f === undefined) continue;
    used.add(b.id);
    const src = f.lines.join('\n');
    if (src === b.body) continue;
    replacements.push({ start: b.charStart, end: b.charEnd, text: src + b.tail });
    updated.push(b.id + '（源：ledger/units/' + f.file + '）');
  }

  // ② 追加：索引里没有的 id ⇒ 追加到文末（统一 "\n" + 块 + "\n" 分隔）。
  const appends = [];
  for (const [id, f] of fencedById) {
    if (used.has(id) || baselineIds.includes(id)) continue;
    appends.push({ id, text: f.lines.join('\n') + '\n', file: f.file });
  }

  let after = before;
  for (const r of replacements.sort((x, y) => y.start - x.start)) {
    after = after.slice(0, r.start) + r.text + after.slice(r.end);
  }
  if (appends.length > 0) {
    const sep = after.endsWith('\n\n') ? '' : (after.endsWith('\n') ? '\n' : '\n\n');
    after = after + sep + appends.map((a) => a.text).join('\n');
  }

  const changed = after !== before;
  const afterCount = scanBlocks(after).length;
  const unregistered = mdFiles
    .map((n) => n.replace(/\.md$/, ''))
    .filter((id) => !baselineIds.includes(id) && !fencedById.has(id));

  console.log('账本根：' + ledgerRoot);
  console.log('索引：ledger/units/index.toml');
  console.log('单元：' + baselineIds.length + ' → ' + afterCount
    + '（新增 ' + appends.length + ' · 按源更新 ' + updated.length + '）');
  for (const a of appends) console.log('  + ' + a.id + '（源：ledger/units/' + a.file + '）');
  for (const u of updated) console.log('  ~ ' + u);
  if (unregistered.length > 0) {
    console.log('未登记且无登记块（本次不动，归属另判）：' + unregistered.join(' / '));
  }

  if (args.check) {
    if (!changed) { console.log('✓ 索引已是最新（逐字节一致）'); return 0; }
    console.log('✗ 索引与源不一致：跑 npm run gen:ledger 重建');
    return 1;
  }
  if (!changed) { console.log('✓ 索引已是最新，未写盘'); return 0; }

  const backupDir = join(ledgerRoot, 'backups', '(root)');
  if (existsSync(backupDir)) {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const stamp = '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
    const bak = join(backupDir, 'index.toml.' + stamp + '.bak');
    copyFileSync(indexPath, bak);
    console.log('备份：' + bak.replace(ledgerRoot + '/', ''));
  }
  writeFileSync(indexPath, after, 'utf8');
  console.log('✓ 已重建 ledger/units/index.toml（' + Buffer.byteLength(before) + ' → ' + Buffer.byteLength(after) + ' 字节）');
  return 0;
}

let code = 2;
try {
  code = main();
} catch (e) {
  console.error('✗ ' + String(e && e.message ? e.message : e));
  code = 2;
}
process.exitCode = code;
