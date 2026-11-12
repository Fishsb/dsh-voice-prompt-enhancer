'use strict';

// 官方语音 Recording 实例探针（2026-11-12 · #15 架构改向）
//
// ═══════════════════════════════════════════════════════════════════════════
// 为什么要有这个模块（取代原先的 getUserMedia 包装）
// ═══════════════════════════════════════════════════════════════════════════
// 旧形态：包装 navigator.mediaDevices.getUserMedia，自建第二个 AudioContext 取帧。
//   现场病历（用户真机，2026-11-12）：诊断区恒显示「没看到录音过程」= 包装器
//   **一次都没被调用**（callCount=0）。根因是外部挂载依赖安装时序与页面生命周期，
//   而 DSH 重启不会重载已打开的浏览器页 ⇒ 旧页面上包装根本没装。
//   这条路径还有第二个脆弱点：即使挂上，也要靠 DOM 相位属性反推录音状态。
//
// 新形态：**不挂任何全局**，只在官方渲染出的活动容器上观察 DOM，
//   从 React fiber 里取出官方自己正在用的 `Recording` 实例，
//   直接调它的 `amplitude()` 读官方自算的 RMS。
//   官方依据（实读源码 packages/experimental/client-ui-voice-input/src/client/audio.ts:114-120）：
//     amplitude(): number {
//       if (!this.analyser) return 0;
//       this.analyser.getFloatTimeDomainData(this.samples);
//       ... return Math.sqrt(sum / this.samples.length);
//     }
//   ⇒ 官方**本来就有** analyser 并逐帧算 RMS（波形组件 Waveform.tsx:16 已在用），
//     我们无需再建 AudioContext，也无需碰 MediaStream。
//
// ⚠ 技术债（必须留档）：fiber 字段名 `__reactFiber$<suffix>` 是 React 内部约定，
//   非公开 API。缓解措施：
//     ① **按形状匹配**（{capture:{amplitude}} / {current:{capture:{amplitude}}}），
//        不依赖 hook 序号、不依赖组件名，官方改 hook 顺序不受影响；
//     ② **双锚点**：活动容器内的按钮 + 麦克风按钮，任一可进；
//     ③ 探针失败**显式进诊断区**（abandonReason='recording-probe-failed'），绝不静默；
//     ④ 官方升级 React 大版本时须复验本模块。

// fiber 字段前缀（React 内部约定；不硬编码后缀）
const REACT_FIBER_PREFIXES = ['__reactFiber$', '__reactInternalInstance$'];
const FIBER_MAX_DEPTH = 60;      // 组件树向上最大搜索深度
const HOOK_MAX_DEPTH = 40;       // 单组件 hook 链最大遍历长度

/** 取元素上的 React fiber 句柄；取不到返回 null。 */
function fiberOf(el) {
  if (!el) return null;
  let keys;
  try { keys = Object.keys(el); } catch (e) { return null; }
  for (const k of keys) {
    for (const p of REACT_FIBER_PREFIXES) {
      if (k.indexOf(p) === 0) return el[k];
    }
  }
  return null;
}

/** 是不是一个可用的官方 Recording（按形状判，不依赖类名）。 */
function isRecording(v) {
  return !!v && typeof v === 'object' && typeof v.amplitude === 'function';
}

/** 从任意 hook 值里按形状挖出 Recording；挖不到返回 null。 */
function recordingIn(value) {
  if (!value || typeof value !== 'object') return null;
  if (isRecording(value)) return value;
  // 官方 VoiceInput 的 ActiveRecording 形状：{ capture: Recording, ... }
  if (isRecording(value.capture)) return value.capture;
  // ref 形状：{ current: ActiveRecording | Recording }
  const cur = value.current;
  if (isRecording(cur)) return cur;
  if (cur && typeof cur === 'object' && isRecording(cur.capture)) return cur.capture;
  return null;
}

/**
 * 从某个 DOM 元素出发，向上遍历 fiber 树与 hook 链，找官方正在用的 Recording。
 * @returns {Recording|null}
 */
function findRecordingFrom(el) {
  let fiber = fiberOf(el);
  let depth = 0;
  while (fiber && depth < FIBER_MAX_DEPTH) {
    // ① 先看 memoizedProps（官方在 props 上是 createRecording 工厂，不是实例，但备用）
    try {
      const fromProps = recordingIn(fiber.memoizedProps);
      if (fromProps) return fromProps;
    } catch (e) { /* 忽略 */ }
    // ② 再遍历该组件的 hook 链（官方把 ActiveRecording 放在 useRef + state 里）
    let hook = fiber.memoizedState;
    let h = 0;
    while (hook && h < HOOK_MAX_DEPTH) {
      try {
        const fromHook = recordingIn(hook.memoizedState);
        if (fromHook) return fromHook;
      } catch (e) { /* 忽略 */ }
      hook = hook.next;
      h++;
    }
    fiber = fiber.return;
    depth++;
  }
  return null;
}

/**
 * 在文档里找官方活动容器（data-voice-activity），并从中取出 Recording。
 * 容器不存在（idle）时返回 { found:false }。
 * @returns {{found:boolean, phase?:string, recording?:object, via?:string}}
 */
function probeOfficialRecording(activityAttr, doc) {
  const attr = activityAttr || 'data-voice-activity';
  // ⚠ 2026-11-12：document 可显式传入（桥把它自己的闭包 document 传进来）。
  //   不传时回落到全局 —— 便于浏览器内直接调试；但**桥与测试都走显式传入**，
  //   否则测试拿到的是 Node 全局（无 document）或真实浏览器 document，与注入的假件不一致。
  const document = doc || (typeof globalThis !== 'undefined' ? globalThis.document : undefined);
  if (!document || typeof document.querySelector !== 'function') {
    return { found: false, why: 'no-document' };
  }
  const container = document.querySelector('[' + attr + ']');
  // 锚点①：活动容器内的按钮（录音/转写/反馈态都有按钮）
  if (container) {
    const phase = container.getAttribute && container.getAttribute(attr);
    let btns = [];
    try { btns = Array.prototype.slice.call(container.querySelectorAll('button')); } catch (e) { btns = []; }
    for (const btn of btns) {
      const rec = findRecordingFrom(btn);
      if (rec) return { found: true, phase: phase, recording: rec, via: 'container-button' };
    }
    // 容器本身也可能直接带 fiber
    const fromContainer = findRecordingFrom(container);
    if (fromContainer) return { found: true, phase: phase, recording: fromContainer, via: 'container' };
  }
  // 锚点②：麦克风按钮（idle 态容器不在，按钮在 composer 里）
  const mic = document.querySelector('button[aria-label="' + String.fromCharCode(0x5f00, 0x59cb, 0x5f55, 0x97f3) + '"]')
    || document.querySelector('button[aria-label="Start recording"]');
  if (mic) {
    const rec = findRecordingFrom(mic);
    if (rec) return { found: true, phase: '', recording: rec, via: 'mic-button' };
  }
  return { found: false, why: container ? 'container-no-instance' : 'no-container' };
}

module.exports = {
  probeOfficialRecording,
  findRecordingFrom,
  recordingIn,
  isRecording,
  fiberOf,
  REACT_FIBER_PREFIXES,
};