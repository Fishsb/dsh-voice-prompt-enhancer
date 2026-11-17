'use strict';

// 目标模式：client 中英文文案普通模块的冻结与产物接线锁。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT } = require('../scripts/lib/chunk-decode.mjs');
const { I18N_MODULE_REL, i18nSource, ZH, EN } = require('./helpers/client-i18n.cjs');

test('CI18N-01 旧 i18n chunk 退役，普通模块与测试单一入口在位', () => {
  assert.equal(fs.existsSync(path.join(REPO_ROOT, 'src/client/i18n.js')), false);
  assert.equal(fs.existsSync(path.join(REPO_ROOT, I18N_MODULE_REL)), true);
  assert.equal(typeof ZH, 'object');
  assert.equal(typeof EN, 'object');
});

// ⚠ PE-41 修复（2026-11-17 · 全功能审查 low）：标题须与下方断言**同值**。
//   ⚠ 第二轮体检订正：本标题曾改成「341 键」，随后 PE-38 删了 49 键使断言变 292，标题没跟着改 ⇒
//     同类问题（标题与断言不一致）在**修完的下一轮立刻复发**。现由 292 同步锁定。
test('CI18N-02 ZH/EN 顶层键集完全相等且保持 292 键', () => {
  // 2026-11-08（语音四件收口批）：299 → **305**（+6 键，逐项可归因：`voiceAutoEnhanceModeLabel` /
  //   `voiceAutoEnhanceModeTip` / `voiceAutoEnhanceModeFollow` / `voiceCorrectionWindowLabel` /
  //   `voiceCorrectionWindowTip` / `voiceCorrectionWindowUnit`；中英各加 6，两侧仍相等）。
  // 2026-11-12（#15 续批）：305 → **306**（+1 键 `voiceOfficialVadSilent`，「静音监测未触发」独立可见态）。
  //   ⚠ 本断言锁的是「两侧键集相等 + 数量不被静默改动」，数量须随**合法新增**同步；判据本身（两侧 deepEqual）未改。
  const zhKeys = Object.keys(ZH).sort();
  const enKeys = Object.keys(EN).sort();
  // 2026-11-12（环境噪声下限批）：306 → **312**（+6 键，逐项可归因：`voiceFloorTest` / `voiceFloorMeasuring` /
  //   `voiceFloorDone` / `voiceFloorCurrent` / `voiceFloorUnset` / `voiceFloorTooFew`；中英各加 6，两侧仍相等）。
  // 2026-11-12（环境噪声测量修复）：312 → **317**（+5 键，逐项可归因：`voiceFloorNoBridge` /
  //   `voiceFloorNoPermission` / `voiceFloorNoDevice` / `voiceFloorUnsupported` / `voiceFloorFailed`——
  //   失败原因必须**分开可见**，一律报「采样不足」会把「没给麦克风权限」误导成「环境太安静」）。
  // 2026-11-13（CHG-390 · 词库改作纠错参考）：317 → **319**（+2 键，逐项可归因：
  //   `voiceDictDisable`（停用态状态词 —— 修「启用态只显示『启用』被误认为动作按钮」的实机误关病历）/
  //   `voiceDictToggleHint`（点击后果说明）；中英各加 2，两侧仍相等）。
  // 2026-11-13（设置面板排版批 · 方案 H）：319 → **332**（+13 键，逐项可归因：
  //   voiceSwitchOff（下拉首项「关」，取代原开关按钮的开/关文案）/
  //   voiceDiagShow / voiceDiagHide（状态区一行摘要 + 诊断展开按钮）/
  //   voiceFloorLabel / voiceFloorUnsetShort / voiceFloorInputTip（环境噪声改可编辑输入框）/
  //   voiceDictTipShort / voiceDictInUseHint / voiceDictEmptyDisabled /
  //   voiceDictMoveOut / voiceDictMoveIn / voiceDictDisabledHint（学习词典改双集合）/
  //   voiceAllOff（三项处理全关时的摘要态）；中英各加 13，两侧仍相等）。
  // 2026-11-17（PE-30 修复 · 全功能审查）：332 → **333**（+1 键，可归因：
  //   `errVoiceOfficialUnavailable` —— 热键启动失败此前回落到 `errUNKNOWN`（「优化失败」），
  //   真实原因不可见；中英各加 1，两侧仍相等）。
  // 2026-11-17（PE-32 修复）：333 → **340**（+7 键：voiceStateOnSuffix / voiceDictCountPrefix /
  //   voiceAgoJustNow / voiceAgoMinutes / voiceAgoHours / voiceAgoDays / voiceAgoSuffix ——
  //   EN 界面曾泄漏「已开启」「 条 · 」「N 天前」；中英各加 7，两侧仍相等）。
  // 2026-11-17（PE-38 清理 · 全功能审查）：341 → **292**（-49 键，逐族可归因：
  //   `upd*` 30 / `env*` 18 / `pluginsSwitch` 1 —— updater 子系统与插件版本切换 UI 已整体退役，
  //   运行时消费面（src/client + lib/client.cjs）实测**零引用**、且无 `'upd'+` / `'env'+` 动态拼接）。
  //   ⚠ 保留 `stage*` 17 键：它们由 `button.cjs:231/237` **动态拼接**消费，静态扫描会误判。
  assert.equal(zhKeys.length, 292);
  assert.equal(enKeys.length, 292);
  assert.deepEqual(zhKeys, enKeys);
});

test('CI18N-03 用户可见文案快照仍逐字命中', () => {
  const source = i18nSource();
  for (const fragment of [
    "navModelPlugins: '提示词 · 语音增强'",
    "voiceSectionTitle: '语音增强'",
    "voiceCorrectionStateRunning: '正在纠错…'",
    "voiceOfficialArmed: '已就绪（等待官方录音）'",
  ]) {
    assert.ok(source.includes(fragment), '文案锚点缺失：' + fragment);
  }
});

test('CI18N-04 共享运行时聚合文案模块，产物不再装载旧 chunk', () => {
  const shared = fs.readFileSync(path.join(REPO_ROOT, 'src/client/common/runtime.cjs'), 'utf8');
  const client = fs.readFileSync(path.join(REPO_ROOT, 'lib/client.cjs'), 'utf8');
  assert.ok(shared.includes("require('./i18n.cjs')"));
  assert.ok(shared.includes('ZH: i18n.ZH'));
  assert.ok(client.includes('src/client/common/i18n.cjs'));
  assert.equal(client.includes('src/client/i18n.js'), false);
  assert.equal((client.match(/require\(['"]\.\.?\//g) || []).length, 0);
});

test('CI18N-05 构建后 ZH/EN 仍从共享运行时同名解构', () => {
  const client = fs.readFileSync(path.join(REPO_ROOT, 'lib/client.cjs'), 'utf8');
  assert.ok(client.includes('ZH: i18n.ZH'));
  assert.ok(client.includes('EN: i18n.EN'));
  assert.ok(client.includes('dictionary: ZH'));
  assert.ok(client.includes('vadRequiredQuiet'));
});
