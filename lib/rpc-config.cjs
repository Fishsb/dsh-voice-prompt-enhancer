'use strict';
// P2-3（2026-10-13 拆分批）：**配置持久化域** —— 原 `lib/index.cjs` D3 段整体移入。
//
// v3.2.4 — RPC: config/get · config/set（配置磁盘持久化）
// 修复 Issue #1：DSH Desktop 主进程每次启动动态分配端口（listen port 0），
// Chromium localStorage 按 Origin（协议://域名:端口）隔离 → 新 Origin 下配置「丢失」，
// client 误判 fresh 用默认链覆盖用户配置。磁盘配置跨端口共享（client 双写 + 启动同步）。
// 存储：$DSH_HOME/dsh-prompt-enhancer.config.json（原子写 tmp+rename，失败不阻断插件）
//
// ⚠ 对外接口（供 RPC 网关与 voice 域共用）：CONFIG_FILE · readConfig() · register(harness)
// ⚠ 本文件是仓库提交物，不是构建产物。

const fs = require('node:fs');
const path = require('node:path');
const { RPC_METHODS } = require('./contracts.cjs');

// 改名过渡（2026-11-05，dsh-voice-prompt-enhancer）：磁盘文件名与包名对齐。
// 本版：新名写入 + 首次使用时自动迁移旧文件（旧文件保留为 .migrated 备份，下一版再整体退役）。
// 读取顺序：新名 → 旧名（旧名仅为迁移前的兜底，下一版可删）。
const CONFIG_BASENAMES = ['dsh-voice-prompt-enhancer.config.json', 'dsh-prompt-enhancer.config.json'];

const CONFIG_DIR = (() => {
  try {
    const dshHome = process.env.DSH_HOME || String(process.env.HOME || process.env.USERPROFILE || '') + '/.dsh';
    fs.mkdirSync(dshHome, { recursive: true });
    return dshHome;
  } catch (e) {
    return null;
  }
})();

/** 写入目标：新名。 */
const CONFIG_FILE = CONFIG_DIR === null ? null : path.join(CONFIG_DIR, CONFIG_BASENAMES[0]);

/** 读取目标：新名优先，旧名回退（迁移完成前）。 */
const CONFIG_READ_CANDIDATES = CONFIG_DIR === null ? [] : CONFIG_BASENAMES.map((b) => path.join(CONFIG_DIR, b));

const LEGACY_CONFIG_FILE = CONFIG_DIR === null ? null : path.join(CONFIG_DIR, CONFIG_BASENAMES[1]);

/**
 * 旧名配置迁移到新名（幂等，仅在新名不存在且旧名存在时执行）。
 * 复制而非移动：旧文件改名保留为 .migrated 备份，回滚到上一发布版时仍能读到原配置。
 */
function migrateLegacyConfig() {
  if (CONFIG_FILE === null || LEGACY_CONFIG_FILE === null) return;
  try {
    if (fs.existsSync(CONFIG_FILE)) return;
    if (!fs.existsSync(LEGACY_CONFIG_FILE)) return;
    fs.copyFileSync(LEGACY_CONFIG_FILE, CONFIG_FILE);
    try {
      fs.renameSync(LEGACY_CONFIG_FILE, LEGACY_CONFIG_FILE + '.migrated');
    } catch (e) { /* 改名失败不阻断：旧文件仍在，读取回退照常工作 */ }
  } catch (e) { /* 迁移失败不阻断插件：readConfig 仍会回退读旧名 */ }
}

/** 实际存在的配置路径（新名优先）；都不存在返回 null。 */
function resolveConfigPath() {
  for (const candidate of CONFIG_READ_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * ⚠⚠ PE-10 修复之三（2026-11-17）：**跨进程写锁**。
 *   病历：唯一 tmp 名只解决「互相覆盖临时文件」（ENOENT），**没解决读-改-写丢更新**——
 *     3 进程各写 60 次，实测 0 次失败但磁盘只剩 81/180 键（后写者用旧快照覆盖先写者）。
 *   修法：`open(lock, 'wx')` 原子创建锁文件 + 自旋重试（`Atomics.wait` 同步小睡，不阻塞事件循环
 *     之外的调度）；超时即返回可判错误码，**不静默丢写**。
 *   ⚠ 用 `wx` 而不是「先 exists 再 open」：后者有 TOCTOU 窗口（多进程仍可能同时通过）。
 *   ⚠ 锁文件残留：持有者崩溃会留下 stale lock ⇒ 超过 STALE_MS 视为过期并抢占（记录 pid 便于排查）。
 */
const CONFIG_LOCK_FILE = CONFIG_DIR === null ? null : path.join(CONFIG_DIR, CONFIG_BASENAMES[0] + '.lock');
const LOCK_TIMEOUT_MS = 5000;
const LOCK_STALE_MS = 10000;

function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* 极简环境降级为忙等 */ }
}

function acquireConfigLock() {
  if (CONFIG_LOCK_FILE === null) return null;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const fd = fs.openSync(CONFIG_LOCK_FILE, 'wx');
      try { fs.writeSync(fd, String(process.pid)); } catch { /* 仅诊断用 */ }
      try { fs.closeSync(fd); } catch { /* ignore */ }
      return { release() { try { fs.unlinkSync(CONFIG_LOCK_FILE); } catch { /* 已释放 */ } } };
    } catch (e) {
      if (e && e.code !== 'EEXIST') return null;
      // stale 抢占：持有者崩溃留下的锁
      try {
        const st = fs.statSync(CONFIG_LOCK_FILE);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) { try { fs.unlinkSync(CONFIG_LOCK_FILE); } catch { /* 竞态 */ } continue; }
      } catch { /* 锁刚被释放 */ }
      if (Date.now() > deadline) return null;
      sleepSync(5);
    }
  }
}

/** 读磁盘配置；文件缺位/损坏/非对象一律返回 null（调用方各自兜底，不抛）。 */
function readConfig() {
  migrateLegacyConfig();
  const file = resolveConfigPath();
  if (file === null) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (e) {
    return null;
  }
}

/**
 * 注册本域 RPC。handlers 经**显式注入**（不共享全局可变状态，P-M3）。
 * ⚠ 「顶层键级 merge」语义仍在此处原文保留（多写入方防互相清空，见下）。
 */
function register(harness) {
  harness.handle(RPC_METHODS.CONFIG_GET, async () => {
    try {
      migrateLegacyConfig();
      const readPath = resolveConfigPath();
      if (readPath === null) return { ok: true, config: null };
      const parsed = JSON.parse(fs.readFileSync(readPath, 'utf8'));
      return { ok: true, config: parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null };
    } catch (e) {
      return { ok: false, code: 'CONFIG_READ_FAILED', message: String((e && e.message) || e) };
    }
  });

  harness.handle(RPC_METHODS.CONFIG_SET, async (args) => {
    try {
      const patch = args && typeof args === 'object' ? args.config : null;
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        return { ok: false, code: 'BAD_ARGS', message: 'config must be an object' };
      }
      if (!CONFIG_FILE) return { ok: false, code: 'NO_DSH_HOME', message: 'cannot resolve DSH_HOME' };
      // v3.2.5（语音模块·多写入方）：config/set 升级为「顶层键级 merge」——enhancer 与 voice
      // 两个模块各写各的顶层键（configState / voice），整体替换会让后写方清空先写方配置。
      // 向后兼容：v3.2.4 唯一写入方（enhancer）传完整 configState → merge 结果与替换等价。
      let merged = {};
      // PE-10（2026-11-17）：读-改-写必须在**跨进程锁**内完成，否则并发写入互相覆盖（丢更新）。
      const lock = acquireConfigLock();
      if (lock === null) return { ok: false, code: 'CONFIG_LOCK_TIMEOUT', message: 'config write lock unavailable (another writer is active)' };
      try {
      migrateLegacyConfig();
      const mergeSource = resolveConfigPath();
      if (mergeSource !== null) {
        // ⚠⚠ PE-10 修复（2026-11-17 · 全功能审查 blocker）：**解析失败不得按空对象合并**。
        //   病历：原实现 `catch (e) { /* 损坏文件按空处理 */ }` ⇒ merged 从 {} 起 ⇒ 随后
        //     `for (k of patch) merged[k] = patch[k]` ⇒ **整份配置被压成该 patch 的键**。
        //   实测：半文件（并发写产物）上发一次 `{config:{template:{mode:'builtin'}}}` ⇒
        //     磁盘 `mode` / `voice` / `params` 全部消失，只剩 `template` ⇒ 用户词典 / 热键 /
        //     静音档位一次性丢光。这是**数据丢失**，不是「覆盖恢复」。
        //   修法：读失败即**拒绝写入**并返回可判错误码，让调用方与用户都能看见。
        try {
          const rawText = fs.readFileSync(mergeSource, 'utf8');
          const cur = JSON.parse(rawText);
          if (cur && typeof cur === 'object' && !Array.isArray(cur)) merged = cur;
          else return { ok: false, code: 'CONFIG_CORRUPT', message: 'existing config is not a JSON object; refusing to overwrite' };
        } catch (e) {
          return { ok: false, code: 'CONFIG_CORRUPT', message: 'existing config is unreadable/corrupt; refusing to overwrite: ' + String((e && e.message) || e) };
        }
      }
      for (const k of Object.keys(patch)) merged[k] = patch[k];
      const size = Buffer.byteLength(JSON.stringify(merged), 'utf8');
      if (size > 1024 * 1024) return { ok: false, code: 'CONFIG_TOO_LARGE', message: 'config exceeds 1MB' };
      fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
      // ⚠⚠ PE-10 修复之二：**tmp 名必须唯一**。
      //   病历：固定 `CONFIG_FILE + '.tmp'` ⇒ 多进程（web + 桌面同 DSH_HOME）并发时互相覆盖
      //     同一临时文件，先 rename 者成功、后者 ENOENT ⇒ 实测 3 进程×60 次有 34 次写失败，
      //     磁盘只剩 25/180 键。
      //   修法：pid + 随机数 ⇒ 每个写入者独占自己的临时文件。
      const tmp = CONFIG_FILE + '.' + process.pid + '.' + Math.random().toString(36).slice(2) + '.tmp';
      try {
        fs.writeFileSync(tmp, JSON.stringify(merged), 'utf8');
        fs.renameSync(tmp, CONFIG_FILE);
      } catch (e) {
        try { fs.unlinkSync(tmp); } catch { /* 已清理 */ }
        return { ok: false, code: 'CONFIG_WRITE_FAILED', message: String((e && e.message) || e) };
      }
      return { ok: true };
      } finally {
        if (lock && typeof lock.release === 'function') lock.release();
      }
    } catch (e) {
      return { ok: false, code: 'CONFIG_WRITE_FAILED', message: String((e && e.message) || e) };
    }
  });
}

// ⚠ `CONFIG_FILE` 是**模块内私有**常量（readConfig / register 用；外部只用 `readConfig`）⇒ **不进导出面**：
//   R5 判「导出面无消费者 = 死码」，导出它会制造假死码项（P2-3 首跑实测命中）。
module.exports = { readConfig, register };
