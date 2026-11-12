'use strict';

// 官方语音桥普通模块（构建期由客户端运行时内联）。
// 浏览器环境与语音配置由调用方显式注入；桥的公开 API 与诊断读数不变。
function createOfficialVoiceBridge(deps) {
  const d = deps && typeof deps === 'object' ? deps : {};
  const window = d.window;
  const document = d.document;
  const navigator = d.navigator;
  const MutationObserver = d.MutationObserver;
  const voiceCfgState = d.voiceCfgState;
  const vadRequiredQuiet = d.vadRequiredQuiet;
  const vadSilenceMsOf = d.vadSilenceMsOf;
  // ⚠ 2026-11-12（#15 架构改向）：Recording 探针**在此处 require**。
  //   ⚠⚠ 必须写在工厂正文内，不能写在模块顶层：测试夹具 factoryBody() 只切取
  //     「工厂正文」（依赖声明之后 → return 之前），写在顶层会被切掉 ⇒ 生产有、测试无（或反之）。
  //   ⚠⚠ 也不能靠「外部注入形参」：生产路径（app.cjs）从未传过它，
  //     现场实测 install() 直接 return false + abandonReason='recording-probe-unavailable'
  //     （诊断区显示「增值功能已停用」，静音监测完全不工作）。
  const officialRecordingProbe = require('./official-recording-probe.cjs');
  // ⚠ 2026-11-12（#15 架构改向）：官方 Recording 探针（按形状从 React fiber 取实例）。
  //   ⚠⚠ 必须 **require 引入**，不能靠外部注入：
  //     最初写成「factory 形参注入」，测试因为自己在 new Function 参数表里传了它而全绿，
  //     但生产路径（app.cjs 调 createOfficialVoiceBridge）**从未传过它**
  //     ⇒ 真实环境里 install() 直接 return false + abandonReason='recording-probe-unavailable'
  //     ⇒ 诊断区显示「增值功能已停用」、静音监测完全不工作（现场实测命中）。
  //   ⇒ 改为模块级 require（与本项目其他 chunk 同构：app.cjs 用 require 引入各域模块）。
// P2-补做（2026-10-13 · CHG-011 / §4.6.2.6 · UD-0014 选 B）：官方录音路径增值桥。
// P2-补做·热键改走官方路径（2026-10-13 · UD-0016 · CHG-011）：
//   **热键 = 远程按一下官方录制按钮 = 一条链、一个状态** ⇒ 本桥新增**启动**能力
//   （`startOfficial()`：派发点击官方开始按钮），并把**停止**的第一优先改为
//   「派发点击官方停止按钮」（语义校验见下），插件自有采集链退居兜底。
//
// 目的：用户点**官方**麦克风按钮、或按**插件热键**时，本插件的两项增值——**静音监测（说完自动停）**
//   与**自动增强**——同样生效，且**走官方同一条链**（相位/电平/停止/上限/转写/写回全归官方）。
// 性质：**知情的高侵入方案**（§4.6.2.6 E5）——包装的是**浏览器标准 API**
//   （`navigator.mediaDevices.getUserMedia` / `MediaRecorder`），并对**官方渲染出来的按钮**
//   派发点击（等价用户按下）；**不改官方任何源码、不注入官方模块、不依赖其私有变量**
//   （官方只经公开 API 调用 ⇒ 不触红线）。
// 定位（UD-0014 第 2 条 / UD-0005 总纲）：**只做增值层的对齐**——采集/识别/写回**全部仍归官方**，
//   插件不接管、不遮蔽、不抢槽位、不恢复自建 🎤（否 C）。
//
// 三条不变量（改本文件时必须保持）：
//   ① **只观测不改行为**：`getUserMedia` 包装原样调用原函数、原样返回原结果（同一性保持，绝不改 stream / 不改参数）。
//   ② **停止必须走完官方链**：官方 `finish()`（相位收尾 → `capture.stop()` → 转写 → 写回）**只能**由
//      官方停止按钮触发 ⇒ 停止第一优先 = 派发点击官方停止按钮；`MediaRecorder.stop()` 仅是兜底
//      （实测语义：官方 `Recording.stop()` 不被 `MediaRecorder.stop()` 触发 ⇒ 单独调它**不会**走 `finish()`）。
//   ③ **不得静默失效**（§4.6.2.6 D）：任何一条失效都必须**可被用户看到**（设置页诊断区），不是只写日志。
//
// 与自建采集链的关系（UD-0016 第 2 条）：自建采集链已**退役**（`recorder.js`/热键模块不再自行
//   取麦、录音、停止、调 `voice/transcribe`）⇒ **不再需要「自控采集」互斥**；但 `setSelfCapture`
//   作为**外部显式声明**保留（有热键在录时，本桥不介入其采集），语义见函数注释。
const OVB_NS = '__dshPeOfficialBridge';
const OVB_REGION = 'dsh-official-voice-activity';
// ⚠ 2026-10-17（判停修复批 · CHG-178）：**绝对阈值下界 OVB_THRESHOLD = 0.025 已拆除**。
//   它不是调小一点就能完事的参数：作为 Math.max() 的下界，它让阈值在底噪 < 0.01 时
//   **完全不再跟随底噪** ⇒ 正常/偏小音量过不了门（用户必须很大声），并被 heardSpeech 闩锁
//   放大成「一降就停」。⇒ 判据改为**相对量**（噪声底 × 倍率），下限改为**与测量分辨率挂钩**。
//   ⚠ 拆的是「绝对下限」这一形态，不是换一个更小的常数（那只是把复发点挪位置）。
const OVB_NOISE_FACTOR = 2.5;          // 开阈倍率（阈值 = 噪声底 × 该值；语义仍为相对倍率）
const OVB_HYSTERESIS = 0.6;            // 关阈 = 开阈 × 该系数（迟滞带内的帧不累计静音 = hangover）
const OVB_THRESHOLD_MAX = 0.2;         // 阈值上限（语义不变）
const OVB_FLOAT_RESOLUTION = 1 / 32768; // float32 容器的有效分辨率 = 16-bit PCM 台阶（2^-15）
//   ⚠ 依据：MediaStreamTrack 虽以 float32 传输，但采集设备的分辨率上限就是 16-bit；
//     float32 容器不会凭空产生更多可测台阶 ⇒ 拿设备分辨率作下限，才谈得上量得出来。
const OVB_RESOLUTION_STEPS = 1;        // 阈值下限 = 分辨率 × 该步数（低于一个台阶的阈值量不出来）
// 噪声底 = **滑动最小值**（最近 N 帧的最小值；不是只降不升，也不是双向自由跟随）
const OVB_NOISE_WINDOW = 100;          // 100 帧 = 10 s @100ms/帧
// ⚠ 2026-11-12：底噪统计量 = 窗口 p20（不是最小值、不是中位数）。理由见 trackFloor 内注释。
const OVB_FLOOR_QUANTILE = 0.2;
const OVB_FLOOR_RISE = 0.02;           // 噪声底向上每帧最多 ×1.02（约 10 s 追平环境变吵）
// 底噪取样门：只有 rms < 底噪 × 该值的帧才参与底噪统计。
//   ⚠ 判据必须是**与阈值无关**的量：若按「是否为语音帧（rms >= 阈值）」取样，
//     就会形成「阈值升高 ⇒ 更多帧被算作非语音 ⇒ 底噪升高 ⇒ 阈值再升高」的正反馈环路
//     （本批实测命中：8-bit 路径底噪从 0.0039 爬到 0.0153，把小声续说压死）。
const OVB_FLOOR_TRACK_RATIO = 1.6;
// ⚠ R4（2026-11-11 · #15 修复批）：取样门的**超时兜底**帧数。
//   病历（真实浏览器 + 确定性夹具双重取证）：门是 rms < 底噪 × 1.6。校准窗若落在比随后环境更安静的时刻
//   （用户按下即开口、或刚切设备/刚开风扇），环境常态会一直高于「底噪 × 1.6」⇒ trackFloor 永不执行
//   ⇒ 底噪永久冻结在过低的校准值 ⇒ 关阈恒低于环境 ⇒ speaking 恒真 ⇒ quietFrames 永为 0 ⇒ **永不判停**。
//   ⚠ 既有 17 条 VAD 判据的夹具里「底噪 = 校准值」（AMB_LOW 恒 0.002），因此这道门在该场景永不卡死 ——
//     这正是此前测试全绿而现场失败的原因。
//   处置：连续 30 帧（3 s）未取样 ⇒ 判门卡死，用本帧强制重估一次。不改常态行为。
const OVB_FLOOR_STALL_FRAMES = 30;
// R4：兜底重估的**单轮封顶倍率**（相对旧底噪）。见 trackFloor 内注释：无上限会把「小声续说」误当环境。
const OVB_FLOOR_STALL_MAX_MULT = 4;
// R4：判 CV 用的窗口长度（帧）。30 帧 = 与兜底周期同长，覆盖一个完整判断周期。
const OVB_FLOOR_STALL_CV_WINDOW = 30;
// R4：判「环境整体抬升」所用窗口内**高于取样门的帧占比**下限。
//   环境真抬升 ⇒ 占比趋近 1；持续小声说话（有字间回落）⇒ 明显低于 1。
//   取 0.9：只在「几乎每帧都高于旧门」时才重估，宁可慢一拍也不误抬。
const OVB_FLOOR_STALL_ABOVE_RATIO = 0.9;
// ⚠ 2026-11-12 (E/A2 ruling): minimum CV for treating a level rise as REAL ambient noise.
//   Measured: real room noise CV ~ 0.29 (ripple); a flat/constant level CV = 0.000.
//   Set 0.10 — comfortably above 'flat' (0.000) and below real ripple (0.29);
//   a constant level therefore never raises the floor, which is what protects A2
//   (do not auto-stop while the user may still be speaking).
const OVB_FLOOR_RISE_MIN_CV = 0.10;
// R4：重估目标取窗口内的低分位（= 当前环境里最安静的那一档，天然不超过环境电平本身）。
const OVB_FLOOR_STALL_ABOVE_LOW_Q = 0.15;
// 连续帧确认：连续 3 帧（=300ms）达到开阈才算有人在说话。
//   ⚠ 为什么是连续而不是窗口内凑够 N 帧：环境噪声起伏常是方波式（风扇/空调/桌面震动），
//     档位一抬就是 2-3 帧，用凑数它照样凑得够 ⇒ 只有底噪也会被确认成语音（C 反向坏）。
const OVB_ONSET_RUN = 3;
// （旧 `OVB_SILENCE_MS = 2000` 已删除：静音时长改由配置提供，详见下方§7.4 说明）
const OVB_POLL_MS = 100;
// P2-补做（2026-10-13 · PROJECT §7.4 / 方案 §4.6.2.7）：静音帧数**不再由固定常量派生**，
// 而是由配置值动态计算 ⇒ 与 VAD 参数同一入口：`vadRequiredQuiet(vadSilenceMsOf(voiceCfgState.value))`。
// 旧写法（已退役）：`OVB_REQUIRED_QUIET = Math.round(OVB_SILENCE_MS / OVB_POLL_MS)`。
// 这是§7.4「静音档位驱动录音入口」的落点——若各自派生，用户改了档位会只对一条路径生效。
const OVB_CALIBRATE_FRAMES = 5;

// 官方按钮的文案锚（官方 zh/en 双语；官方源码 lib/client.js:5254/5255/5358/5359 实读）
const OVB_START_LABELS = ['开始录音', 'Start recording'];
const OVB_STOP_LABELS = ['停止并识别', 'Stop and transcribe'];
// ⚠ 未识别态批（2026-10-15 · 需求 3+4）：官方「未识别到语音」窗口渲染的**不是**开始按钮，
//   而是 aria-label = 上列（`重新录音` / `Record again`）的 retry 按钮 —— **CDP 实读**（报告 §②）：
//   feedback 窗口内只有两个按钮：`取消` 与 `重新录音`（均在位、均未 disabled）。
//   官方源码依据：voice-input/lib/client.js:5150-5160（feedback 且无 pending ⇒ roundButton,
//   aria-label: t('retryRecording')，onClick: () => start()）；键值 client.js:5199 / :5303。
//   ⚠ 旧实现只按 OVB_START_LABELS 找 ⇒ 该窗口**找不到任何按钮** ⇒ startMissed
//   ⇒ 热键「接不上」（用户报障的需求 4 形态）。
const OVB_RETRY_LABELS = ['重新录音', 'Record again'];
// 官方 DOM 相位锚（只读官方渲染结果）+ 官方失败出口文案节点
const OVB_ACTIVITY_ATTR = 'data-voice-activity';
const OVB_RECORDING_PHASE = 'recording';
const OVB_FEEDBACK_PHASE = 'feedback';
// 官方相位取值集合（穷举，官方源码实读）：idle | requesting | recording | transcribing | feedback
// ⚠ idle 时该节点根本不挂载（`expanded = phase !== "idle"`）⇒ 属性只在非 idle 存在。
const OVB_TRANSCRIBING_PHASE = 'transcribing';
const OVB_REQUESTING_PHASE = 'requesting';
// 官方失败出口的文案节点类名（`.activityMessage`，承载「未识别到语音」等官方文案）
const OVB_MESSAGE_CLASS = 'activityMessage';
// ⚠ B-1（2026-10-14 定位批 · CDP 实读官方 DOM）：该节点是 **CSS-module 哈希类**
//   （实测 `ddpbLW_activityMessage`）⇒ 裸 `.activityMessage` 选择器 **永不命中**（CDP 实测命中 0）。
//   故改用**子串匹配**（官方源码键名仍是 activityMessage ⇒ 哈希变化时依然命中），保留裸类名作后备。
const OVB_MESSAGE_CLASS_ATTR = '[class*="' + OVB_MESSAGE_CLASS + '"]';

function ovbBus() {
  if (typeof window === 'undefined') return null;
  if (!window[OVB_NS]) {
    window[OVB_NS] = {
      installed: false,
      sessionObserver: null,   // 2026-11-12：观察官方活动容器的 MutationObserver（取代 getUserMedia 包装）
      original: null,
      originalRecorder: null,   // 兜底：原 window.MediaRecorder
      wrappedRecorder: false,
      recording: null,          // 兜底：当前官方采集的 MediaRecorder 实例
      active: false,            // 官方采集进行中（含握手/收尾）
      lastEndedAt: 0,           // 官方会话结束时刻（自动增强的触发信号源）
      firstCallAt: 0,           // 包装器首次被调用（诊断）
      lastCallAt: 0,
      sessionsStarted: 0,       // 观察到的官方会话数（相位上升沿）
      sessionsMissed: 0,        // 有会话但包装器从未被调用的次数（= 自动停未生效）
      lastMissedAt: 0,
      callCount: 0,             // 包装器被调用的**总次数**（诊断/判 missed 用）
      callCountAtPrevSessionEnd: 0, // 上一次会话收口时的调用计数（判 missed 的窗口下界）
      abandonReason: '',        // 显式降级原因（''=无降级）
      selfCapture: false,       // 外部（热键）声明「正在自采」⇒ 本桥不介入其采集
      timerSvc: null,
      listeners: new Set(),
      // ── 热键改走官方路径（UD-0016）新增：启动/停止派发点击与官方失败出口读数 ──
      lastPhase: '',            // 最近一次观察到的官方相位（诊断；idle 时为空串）
      startClicks: 0,           // 成功派发点击官方开始按钮的次数
      startMissed: 0,           // 找不到官方开始按钮而未能启动的次数（= 不得静默失效）
      lastStartMissedAt: 0,
      stopClicks: 0,            // 成功派发点击官方停止按钮的次数
      stopMissed: 0,            // 找不到官方停止按钮而未能停止的次数
      // ⚠ 未识别态批（2026-10-15）：需求 4 新增的 retry 路径读数（不得静默失效）——
      //   没有它就只能靠 startClicks 总数区分不出「走的是哪条锚」。
      retryClicks: 0,           // 经「未识别窗口 retry 按钮」成功启动的次数
      lastStartVia: '',         // 最近一次成功启动走的锚（诊断用；'' = 从未启动）
      feedbackSeen: 0,          // 观察到官方失败出口（相位 feedback）的次数
      lastFeedbackAt: 0,
      feedbackMessage: '',      // 官方失败出口的文案（`.activityMessage` 文本，只读）
      endedInFeedback: false,   // 本次官方会话以失败出口收尾 ⇒ 订阅方**不进入**「等写回 → 自动增强」
      // ⚠ CHG-090（2026-10-15 诊断如实化批）：`feedbackSeen` 是**页面生命期累计**（只在 uninstall 归零）
      //   ⇒ 拿它判「上次会话」会把**历史残留**读成**当前失败**（用户最初报障看到的那行正由此而来）。
      //   新增**会话级**读数：**最近一次已收口的会话**是否走了官方失败出口。
      //   置位：会话以 feedback 收口；复位：新会话开始 / 会话成功收口 / 从 feedback 重试 / uninstall。
      lastSessionFailed: false,
      // ⚠ VAD-1（2026-10-14）：静音判定的**可判别读数**（此前「门从未开过」这一失效形态
      //   在本快照里**没有任何字段** ⇒ 用户只能看到一句会误导的文案，属「会掩盖问题」。）
      vadHeardSpeech: false,    // 本会话内 heardSpeech 是否曾为真（门是否开过）
      vadQuietFrames: 0,        // 当前连续静音帧数
      vadThreshold: 0,          // 当前生效阈值（自愈后）
      vadNoiseFloor: 0,         // 当前底噪估计
      // ⚠ 2026-10-17（判停修复批 · F-5「不得静默失效」）：上面 4 个字段只能回答「门是否**曾**开过」，
      //   回答不了「门开着但没声音」vs「门根本没开」—— 正是「判据全绿而现场失败」的同族缺口。
      //   ⇒ 以下字段**逐帧刷新**，读的是**当下**而不是历史：
      vadFrameSpeech: false,    // 本帧判定（true=本帧判为有声）
      vadSpeaking: false,       // 当前是否处于「说话」态（双阈值迟滞的状态机位）
      vadRms: 0,                // 本帧原始 RMS（平滑前；区分「门没开」与「没声音」的关键）
      vadSnr: 0,                // 本帧 rms / 噪声底（相对判据的比值）
      vadThresholdOff: 0,       // 关阈（迟滞带下沿）
      vadResolution: 0,         // 当前判据下限（= 采集分辨率，随路径变）
      vadPath: '',              // 实际采集路径：'float'（getFloatTimeDomainData）| 'byte'（8-bit）
      vadPathErrors: 0,         // 采集路径回落/读失败次数（fail-closed 的证据）
      vadFrames: 0,             // 已处理帧数（tick 计数）
      vadCalibrating: true,     // 是否仍在校准窗内
      // ⚠ SW-1：开关的可判读数（此前「开关关了但 VAD 照跑」在快照里**无任何字段** ⇒ 无法判别）
      vadSkipped: 0,            // 因开关关闭而**未启动** VAD 的音频采集次数（开关真的约束了行为的证据）
    };
  }
  return window[OVB_NS];
}

function ovbNotify() {
  const b = ovbBus();
  if (!b) return;
  for (const fn of [...b.listeners]) { try { fn(); } catch (e) { /* 单个订阅者失败不影响其余 */ } }
}

function ovbSubscribe(fn) {
  const b = ovbBus();
  if (!b) return () => {};
  b.listeners.add(fn);
  return () => b.listeners.delete(fn);
}

// 诊断快照（设置页诊断区读取；**不静默**的就地来源）
function ovbSnapshot() {
  const b = ovbBus();
  if (!b) return null;
  return {
    installed: b.installed,
    firstCallAt: b.firstCallAt,
    lastCallAt: b.lastCallAt,
    callCount: b.callCount || 0,   // 包装器被调用总次数
    callCountAtPrevSessionEnd: b.callCountAtPrevSessionEnd || 0,   // missed 判据窗口下界
    sessionsStarted: b.sessionsStarted,
    sessionsMissed: b.sessionsMissed,
    lastMissedAt: b.lastMissedAt,
    abandonReason: b.abandonReason,
    recording: !!b.active,
    lastEndedAt: b.lastEndedAt,
    selfCapture: !!b.selfCapture,
    lastPhase: b.lastPhase,
    startClicks: b.startClicks,
    startMissed: b.startMissed,
    lastStartMissedAt: b.lastStartMissedAt,
    retryClicks: b.retryClicks || 0,
    lastStartVia: b.lastStartVia || '',
    stopClicks: b.stopClicks,
    stopMissed: b.stopMissed,
    feedbackSeen: b.feedbackSeen,
    lastSessionFailed: !!b.lastSessionFailed,
    // 2026-10-17（设置文案审查批 · 用户第二轮报障 D）：lastSessionFailed 的复位条件只有
    //   「之后录了一场成功会话」⇒ 若很久没录音，就会一直挂着某个陈年失败。**不吞掉**该事实，
    //   但把**发生时刻**一并暴露 ⇒ 设置页可以给出「距今多久」，用户自己判得了是不是当前问题。
    //   ⚠ 只加只读出口，不改任何置位/复位语义（复位条件仍只有成功会话）。
    lastSessionFailedAt: b.lastFeedbackAt || 0,
    lastFeedbackAt: b.lastFeedbackAt,
    feedbackMessage: b.feedbackMessage,
    endedInFeedback: !!b.endedInFeedback,
    vadHeardSpeech: !!b.vadHeardSpeech,
    vadQuietFrames: b.vadQuietFrames || 0,
    vadThreshold: b.vadThreshold || 0,
    vadNoiseFloor: b.vadNoiseFloor || 0,
    vadEnabled: ovbVadEnabled(),   // 开关**当前**真值（实时读配置；不是历史快照）— 诊断区据此区分「已关闭」与「已开启但未触发」
    vadSkipped: b.vadSkipped || 0,
    // ⚠ 2026-10-17（判停修复批 · F-5）：**当下**读数（不是"曾开过"）；逐帧刷新。
    vadFrameSpeech: !!b.vadFrameSpeech,
    vadSpeaking: !!b.vadSpeaking,
    vadRms: b.vadRms || 0,
    vadSnr: (typeof b.vadSnr === 'number') ? b.vadSnr : 0,
    vadThresholdOff: b.vadThresholdOff || 0,
    vadResolution: b.vadResolution || 0,
    vadPath: b.vadPath || '',
    vadPathErrors: b.vadPathErrors || 0,
    vadFrames: b.vadFrames || 0,
    vadCalibrating: !!b.vadCalibrating,
    // 设置页诊断行 title 的**一次拼入**形态（把这一串整体放进 title 即可，不必逐字段改文案）
    vadDiag: 'path=' + (b.vadPath || '-')
      + ' rms=' + (b.vadRms || 0).toFixed(4)
      + ' snr=' + ((typeof b.vadSnr === 'number') ? b.vadSnr : 0).toFixed(2)
      + ' frame=' + (b.vadFrameSpeech ? 'speech' : 'quiet')
      + ' thr=' + (b.vadThreshold || 0).toFixed(4)
      + ' thrOff=' + (b.vadThresholdOff || 0).toFixed(4)
      + ' floor=' + (b.vadNoiseFloor || 0).toFixed(4)
      + ' res=' + ((b.vadResolution || 0) > 0 ? b.vadResolution.toExponential(1) : '0')
      + ' frames=' + (b.vadFrames || 0)
      + ' cal=' + (b.vadCalibrating ? 1 : 0),
  };
}

// 可关闭：环境标志 / localStorage 配置均可停用包装（§4.6.2.6 E1④）
function ovbDisabled() {
  try {
    if (typeof window !== 'undefined' && window.__dshPeDisableOfficialBridge === true) return true;
  } catch (e) { /* 忽略 */ }
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem('dsh.prompt-enhancer.officialBridge') === 'off') return true;
  } catch (e) { /* 忽略 */ }
  return false;
}

// ⚠ SW-1（2026-10-15 接线批 · 用户可见开关不得说假话）：`vad.enabled` 此前**未被本文件消费**
//   （穷举实测：`voice-section.js` 写 8 处 / 本文件**引用 0 处**）⇒ 用户关掉「静音监测」开关，
//   VAD **照跑**、仍会派发点击官方停止 = **开关说了假话**（属「让失败不可观测」类，CHG-065 同族）。
//   现接上：`enabled === false` ⇒ **不启动 VAD**（不建 AudioContext、不观测、不自动停）。
//   ⚠ 与 `autoEnhance` **完全无关**：关「静音监测」≠ 关「自动增强」——两者各读各的配置，
//     `autoEnhance` 的读取点始终只有热键模块那一处（本批**未触碰**）。
//   ⚠ 只接开关：**未改动**判定算法 / 阈值策略 / 派发路径（派发仍**只**在 VAD 判到静音时发生）。
//   缺配置 / 缺 `vad` 字段 ⇒ 视为**开**（保持既有默认行为，不改动未配置用户的语义）。
function ovbVadEnabled() {
  try {
    const v = (typeof voiceCfgState !== 'undefined' && voiceCfgState) ? voiceCfgState.value : null;
    const vd = v && v.vad ? v.vad : null;
    return !vd || vd.enabled !== false;
  } catch (e) { return true; }
}

// ── 外部显式声明「自采进行中」：本桥在其采集上**不介入**（不挂 VAD）────────────────
// ⚠ UD-0016 后语义收窄：自建采集链已退役 ⇒ 正常情况下**无人**再置此标记；
//   保留它是为了「有第三方/未来实现自行采集时，本桥明确不介入」这一显式契约（默认 false = 介入）。
function ovbSetSelfCapture(on) {
  const b = ovbBus();
  if (!b) return;
  b.selfCapture = on === true;
}
// 包装器侧：外部自采中 ⇒ 直接透传不介入
function ovbSelfCapturing() {
  const b = ovbBus();
  return !!(b && b.selfCapture);
}
// 热键侧：**官方确在采集中** ⇒ 拒绝重复启动（互斥保护 —— **有意保留**，本批未取消）。
// ⚠ 未识别态批（2026-10-15 · 需求 1/3 · 用户报障的确切形态）：判据从 `b.active` 改为
//   **官方自己渲染的相位真相**（`[data-voice-activity="recording"]`）。
//   `b.active` 的语义是「官方仍占用语音入口」，它在 feedback / 收尾态**仍为真**
//   （bridge 有意保持，见 ovbWatchActivity 内注释与 CHG-085 收口语义）⇒ 旧实现把
//   「**卡在收尾/未识别态**」与「**仍在采集中**」混为一谈 ⇒ 返回 already-capturing ⇒ 热键被拒。
//   现在：只有 recording 相位存在（= 采集确在进行中）才拒绝；
//   transcribing / feedback（未识别）/ 失败态 / 节点已卸载 ⇒ **不算采集中** ⇒ 放行，交由
//   ovbStartOfficial 重新启动一轮。
//   ⚠ 判据用**直接 DOM 相位查询**而非 b.active / b.lastPhase（后两者无法区分「还在录」与「已收尾」，
//     这正是 ovbStopOfficial 的 N-1 修复已记录过的同一陷阱）。
function ovbOfficialCapturing() {
  return ovbRecordingNow();
}
// ⚠ 与上面**语义不同**（不可互换）：官方是否仍**占用语音入口**（含收尾/未识别态）。
//   保留它是为了不丢 b.active 的既有承诺面（诊断区 / 订阅方 / CHG-085 收口语义都依据它）。
function ovbOfficialEntryBusy() {
  const b = ovbBus();
  return !!(b && b.active);
}

// ── 官方按钮定位与派发点击（等价用户按下；只读官方渲染结果，不改官方）────────────
// 统一派发点击：优先 `window.MouseEvent`（client chunk 的未声明标识符门禁 R2 只认白名单全局名，
// 裸 `MouseEvent` 会被判「未声明」⇒ 门禁 FAIL，实测命中）；不可用时回落 `el.click()`。
function ovbClickElement(el) {
  try {
    const EvCtor = (typeof window !== 'undefined' && typeof window.MouseEvent === 'function') ? window.MouseEvent : null;
    if (EvCtor) {
      el.dispatchEvent(new EvCtor('click', { bubbles: true, cancelable: true }));
      return true;
    }
    el.click();
    return true;
  } catch (e) {
    try { el.click(); return true; } catch (e2) { return false; }
  }
}

// 在「当前官方相位节点」内按 aria-label 找可用按钮；scope 不可查询时回落整文档。
function ovbFindButtonByLabels(labels, phaseAttr) {
  if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return null;
  const sel = phaseAttr
    ? '[' + OVB_ACTIVITY_ATTR + '="' + phaseAttr + '"]'
    : '[' + OVB_ACTIVITY_ATTR + ']';
  const region = (typeof document.querySelector === 'function') ? document.querySelector(sel) : null;
  // 只在 scope 确实可查询时收窄搜索面；否则回落整文档（元素缺失 querySelectorAll 不得使其崩掉）
  const scope = (region && typeof region.querySelectorAll === 'function') ? region : document;
  if (typeof scope.querySelectorAll !== 'function') return null;
  const btns = scope.querySelectorAll('button');
  for (const el of btns) {
    const label = el.getAttribute('aria-label') || '';
    if (labels.indexOf(label) >= 0 && !el.disabled) return el;
  }
  return null;
}

// 官方「开始录音」按钮：**只在 idle（相位节点未挂载）时存在**（官方 `expanded = phase !== "idle"`）。
// ⚠ 因此**不得**按相位属性收窄搜索（idle 时该属性不存在）⇒ 用整文档 + aria-label。
function ovbFindStartButton() {
  return ovbFindButtonByLabels(OVB_START_LABELS, null);
}

// 官方「未识别」窗口的 retry 按钮（aria-label = 重新录音 / Record again）：
//   只在 feedback 相位节点内存在 ⇒ 先按相位锚收窄（外带整文档兜底）。
//   CDP 实读（报告 §②）：该窗口的按钮就是这个 + `取消`（取消**不**得被当作启动锚）。
function ovbFindRetryButton() {
  const scoped = ovbFindButtonByLabels(OVB_RETRY_LABELS, OVB_FEEDBACK_PHASE);
  if (scoped) return scoped;
  return ovbFindButtonByLabels(OVB_RETRY_LABELS, null);
}

// 官方「停止并识别」按钮：只在 recording 相位节点内存在 ⇒ 先按相位锚收窄，再按文案。
function ovbFindStopButton() {
  const scoped = ovbFindButtonByLabels(OVB_STOP_LABELS, OVB_RECORDING_PHASE);
  if (scoped) return scoped;
  return ovbFindButtonByLabels(OVB_STOP_LABELS, null);
}

// ── 启动官方采集（热键 → 远程按一下官方开始按钮）────────────────────────────────
// 只有派发点击官方开始按钮能驱动官方整条链：官方相位是组件私有 useState，
// `actions.createRecording()` 虽能开麦但**不驱动相位**（轮次 22 勘察 §1③ 实读）。
function ovbStartOfficial() {
  const b = ovbBus();
  if (!b) return { started: false, via: 'no-bus' };
  if (ovbOfficialCapturing()) return { started: false, via: 'already-capturing' };
  // ⚠ 未识别态批（2026-10-15 · 需求 3+4）：两条入口各有一个**官方自己渲染**的启动锚，
  //   按「当前相位下真实存在的那个」依序尝试 —— 两次点击的语义在官方侧**完全相同**
  //   （都是 `start()`，voice-input/lib/client.js:5089-5091 与 :5156-5158），差别只在文案锚。
  //   ① feedback（未识别）窗口 ⇒ retry 锚（重新录音 / Record again）
  //   ② idle ⇒ 开始锚（开始录音 / Start recording）
  //   ⚠ 顺序不可颠倒：retry 先试（它只在 feedback 存在，且必须优先命中）；
  //     两者互斥共存（feedback 时开始锚**不渲染**，idle 时 retry 锚不存在）⇒ 不会误点。
  const candidates = [
    { el: ovbFindRetryButton(), via: 'official-retry-button' },
    { el: ovbFindStartButton(), via: 'official-start-button' },
  ];
  let foundAny = false;
  for (const c of candidates) {
    if (!c.el) continue;
    foundAny = true;
    if (!ovbClickElement(c.el)) continue;   // 找到但派发失败 ⇒ 试下一个锚，最终不静默
    if (c.via === 'official-retry-button') b.retryClicks++;
    else b.startClicks++;
    b.lastStartVia = c.via;
    ovbNotify();
    return { started: true, via: c.via };
  }
  // 不得静默失效：两个锚都不可用必须留下可见读数（设置页诊断区）
  b.startMissed++;
  b.lastStartMissedAt = Date.now();
  const failVia = foundAny ? 'start-click-dispatch-failed' : 'start-button-not-found';
  b.abandonReason = b.abandonReason || failVia;
  ovbNotify();
  return { started: false, via: failVia };
}

// 官方当前是否**确在录音**（直接读官方渲染的相位属性，不依赖 bus 缓存）——
// N-1 修复的判据基元：`[data-voice-activity="recording"]` 是官方**自己**渲染的真相，
// 「采集确在进行中」= 它存在。会话收尾（transcribing/feedback）或节点卸载 ⇒ 不存在。
function ovbRecordingNow() {
  try {
    if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return false;
    return !!document.querySelector('[' + OVB_ACTIVITY_ATTR + '="' + OVB_RECORDING_PHASE + '"]');
  } catch (e) { return false; }
}

// ── 停止官方采集：派发点击官方停止按钮（唯一走完官方链的路径）→ MediaRecorder 兜底 → 显式降级 ──
// ⚠ 语义校验（本轮实读官方源码）：官方 `finish()` 才做「相位收尾 → `capture.stop()` → 转写 → 写回」，
//   而它**只**由官方停止按钮的 onClick 触发（`client.js` 停止按钮 `onClick: () => { finish(); }`）。
//   直接调 `MediaRecorder.stop()` 既不改官方相位、也不转写/写回 ⇒ **不能**作为第一优先
//   （用户要「一条链、一个状态」⇒ 必须走官方停止按钮）。
//   返回 `via` 面：主路 'A1'（官方停止按钮）· 兜底 'A2'（MediaRecorder 实例）· 'abandoned'（显式降级）。
function ovbStopOfficial() {
  const b = ovbBus();
  if (!b) return { stopped: false, via: 'no-bus' };
  // A1（第一优先）：派发点击官方停止按钮 —— 唯一能走完官方 finish() 的路径
  const btn = ovbFindStopButton();
  if (btn && ovbClickElement(btn)) {
    b.stopClicks++;
    ovbNotify();
    return { stopped: true, via: 'A1' };
  }
  // A2（兜底）：持官方 MediaRecorder 实例调 .stop()——只停采集，不走官方转写/写回
  if (b.recording && b.recording.state === 'recording') {
    try {
      b.recording.stop();
      return { stopped: true, via: 'A2' };
    } catch (e) { /* 落到显式降级 */ }
  }
  // ⚠ N-1 修复（2026-10-13 · 与 F-1/F-2/F-10 同类「读数说反话」）：**只有「采集确在进行中」才计降级**。
  //   实测形态：一次**正常手动停**之后，相位停在 `feedback`（节点不消失）⇒ 静默的包装 VAD 仍在跑；
  //   它随后在**录音器已释放**时到达阈值 ⇒ 旧实现照记一次 stopMissed + 写 `abandonReason`，
  //   而该字段是诊断区**第一优先分支** ⇒ 此后设置页**一直**显示「自动停已降级」，
  //   而自动停**从未失败**（用户看到与事实相反且不消失的状态）。
  //   语义①（本处）：**官方当前不在 `recording` 相位**（会话未开 / 已进入 `transcribing`·`feedback`
  //   收尾 / 节点已卸载）⇒ **不计 missed、不写 reason**，只如实返回未停止。
  //   ⚠ 判据用**直接 DOM 相位查询**（不信 `b.lastPhase`：它把 `transcribing` 归为 `'active'`，
  //   不足以区分「还在录」与「已收尾」——这是本修复第一次写错并自查发现的点）。
  if (!ovbRecordingNow()) {
    return { stopped: false, via: 'no-active-session' };
  }
  // 显式降级：不假装已停——记原因，由设置页诊断区可见（§4.6.2.6 D 第 3 行）
  b.stopMissed++;
  // ⚠ R3（2026-11-12 · #15 后续）：原为**无条件赋值** ⇒ 会抹掉更早、更接近根因的降级原因
  //   （实测：float 脏回落 byte 先写入的 'vad-float-path-fallback' 会被这里覆盖成停止按钮缺失，
  //     诊断第一优先分支从此只能看到后者 ⇒ 排查起点失真）。改为「保留首个原因」——与 :503 同语义。
  if (!b.abandonReason) {
    b.abandonReason = btn ? 'stop-click-dispatch-failed' : (b.recording ? 'stop-failed-both-paths' : 'no-stop-button-and-no-recorder');
  }
  ovbNotify();
  return { stopped: false, via: 'abandoned' };
}

// ── 官方同一路 stream 上挂插件自己的分析器判静音（只读 stream，不修改它）──────
// ⚠ 2026-10-17（判停修复批 · CHG-178）：**判据形态变更**（不是参数调整）。
//   改前三件叠加：绝对下界 Math.max(0.025, …) 把阈值钉死 · 0.7/0.3 指数平滑再压约 3 dB ·
//   heardSpeech 一次性闩锁永不复位 ⇒ 「必须很大声」+「一降就停」。
//   改后：**相对判据**（瞬时 rms 与「噪声底 × 倍率」比较）+ 双阈值迟滞 + 连续帧确认 + 逐帧可判读数。
//   为什么**必须**是相对量（不是把 0.025 改小）：官方 getUserMedia **不传 autoGainControl**
//   （实读官方 dsh-experimental-client-ui-voice-input/lib/client.js:1532-1534：只有 echoCancellation /
//   noiseSuppression / deviceId）⇒ AGC 交给浏览器默认（通常开）⇒ 同一句话的**绝对** RMS 前后不可比；
//   而 AGC 同时放大语音与环境噪声 ⇒ **比值近似不变**。⛔ 本桥不变量①禁止改官方 constraints（那才是越界）。
//   下限为什么不是更小的常数：下限 = **当前采集路径的量化台阶**（测量分辨率），不是经验值。
// 2026-11-12 (#15 architectural change): frame source switched from a self-built
// AudioContext + MediaStream to the *official* Recording.amplitude()
// (official audio.ts:114-120 already computes RMS per frame).
//
// Why: the old form had to wrap navigator.mediaDevices.getUserMedia to obtain the stream;
// on the user's real machine that wrapper was NEVER called (callCount=0, the diag row read
// 'no recording observed'). Reading the official instance directly removes that dependency
// entirely: no global API touched, no install-timing requirement, no page reload needed,
// the audio source IS the official analyser, and recording state comes from instance
// presence rather than DOM phase inference.
//
// IMPORTANT: the decision logic below is UNCHANGED (calibration, sampling gate + stall
// fallback, hysteresis, consecutive-frame onset, never-spoke lock, live requiredQuiet).
// All 19 VAD criteria stay valid; only the data source changed.
// Frames are always float now, so resolution is fixed at OVB_FLOAT_RESOLUTION and the
// 8-bit fallback path no longer exists in this form.
function ovbStartVad(getAmp, onSilence) {
  const b = ovbBus();
  if (!b) return null;
  if (typeof getAmp !== 'function') { b.abandonReason = 'no-amplitude-source'; return null; }
  let ctx = null;
  try {
    const resolution = OVB_FLOAT_RESOLUTION;
    const pathErrors = 0;
    const readRms = () => {
      try {
        const v = getAmp();
        return (typeof v === 'number' && Number.isFinite(v) && v >= 0) ? v : 0;
      } catch (e) {
        return 0;
      }
    };
    let heardSpeech = false;      // 本会话内**是否曾**确认到语音 —— 「从未说话不得判停」的反向锁（保留）
    let speaking = false;         // 当前是否处于「说话」态（双阈值迟滞的状态机位）
    let aboveRun = 0;             // 连续达到开阈的帧数（连续帧确认）
    let quietFrames = 0;
    let stopped = false;
    let noiseFloor = 0;           // 噪声底（最近 OVB_NOISE_WINDOW 帧的最小值；向上速率受限）
    let vadThreshold = resolution * OVB_NOISE_FACTOR;   // 开阈（确认有人说话）
    let vadThresholdOff = vadThreshold;                 // 关阈（迟滞带下沿 = 仍在说话）
    let calibrating = true;
    let frames = 0;
    const noiseSamples = [];
    const quietWindow = [];
    // 阈值下限 = 测量分辨率（8-bit RMS ≈ 1/256；float ≈ 2^-15）。
    //   ⚠ 与「分辨率」挂钩，不是挑了一个更小的经验常数（后者只是把复发点挪到看不见的地方）。
    const measurableFloor = () => resolution * OVB_RESOLUTION_STEPS;
    // 由噪声底重算双阈值：开阈 = 底噪 × NOISE_FACTOR（不高于上限）；
    //   关阈 = 开阈 × HYSTERESIS（不低于底噪）。迟滞带内的帧**不**累计静音帧（= hangover）。
    const applyFloor = () => {
      const f = Math.max(noiseFloor, measurableFloor());
      vadThreshold = Math.min(OVB_THRESHOLD_MAX, f * OVB_NOISE_FACTOR);
      vadThresholdOff = Math.min(vadThreshold, Math.max(f, vadThreshold * OVB_HYSTERESIS));
    };
    applyFloor();
    // 噪声底 = **滑动最小值**。取样门**与阈值无关**（⚠ 关键）：
    //   若按「是否为语音帧（rms >= 阈值）」取样，会形成
    //   「阈值升高 ⇒ 更多帧被判为非语音 ⇒ 底噪升高 ⇒ 阈值再升高」的**正反馈**
    //   （本批实测命中：8-bit 路径底噪从 0.0039 爬到 0.0153，把小声续说压死）。
    //   取样门 = rms < 底噪 × OVB_FLOOR_TRACK_RATIO（只看像不像环境电平）；
    //   向上速率护栏 OVB_FLOOR_RISE/帧（约 10 s 追平环境变吵，但不会一大跳）。
    // R4（2026-11-11 · #15）：**取样门卡死兜底**。见下方 OVB_FLOOR_STALL_FRAMES 注释。
    let floorStall = 0;
    // 滑动窗口的变异系数 —— 判「窗口里是真实起伏的噪声」还是「一段平直电平」。
    //   实测：真实房间噪声 CV ≈ 0.29；平直电平 CV = 0.000。
    const quietWindowCv = () => {
      if (quietWindow.length < 8) return 0;
      let sum = 0;
      for (let i = 0; i < quietWindow.length; i++) sum += quietWindow[i];
      const mean = sum / quietWindow.length;
      if (!(mean > 0)) return 0;
      let varSum = 0;
      for (let i = 0; i < quietWindow.length; i++) { const d = quietWindow[i] - mean; varSum += d * d; }
      return Math.sqrt(varSum / quietWindow.length) / mean;
    };
    const stallRecent = [];   // 最近若干帧的 rms（判「环境抬升」vs「持续说话」用）
    // 只看窗口**后段**（最近 1/3）的变异系数 —— 语音刚结束时整窗仍含高值帧，会把 CV 抬高到 0.8，
    //   掩盖「尾段其实是平直电平」这一事实。实测：尾段窗口下 flat=0.000 / ripple≈0.25，可分。
    const stallTailCv = () => {
      const n = stallRecent.length;
      if (n < 10) return 0;
      const from = Math.floor(n * 2 / 3);
      let sum = 0, cnt = 0;
      for (let i = from; i < n; i++) { sum += stallRecent[i]; cnt++; }
      const mean = sum / cnt;
      if (!(mean > 0)) return 0;
      let varSum = 0;
      for (let i = from; i < n; i++) { const d = stallRecent[i] - mean; varSum += d * d; }
      return Math.sqrt(varSum / cnt) / mean;
    };
    const stallCv = () => {
      if (stallRecent.length < 5) return 0;
      let sum = 0;
      for (let i = 0; i < stallRecent.length; i++) sum += stallRecent[i];
      const mean = sum / stallRecent.length;
      if (!(mean > 0)) return 0;
      let varSum = 0;
      for (let i = 0; i < stallRecent.length; i++) { const d = stallRecent[i] - mean; varSum += d * d; }
      return Math.sqrt(varSum / stallRecent.length) / mean;
    };
    // ═══════════════════════════════════════════════════════════════════════════
    // 噪声底估计（2026-11-12 重写：此前叠加了 6 层互相干扰的护栏，现场反复失效）
    // ═══════════════════════════════════════════════════════════════════════════
    // 目标只有两个，且必须同时成立：
    //   ① 环境变吵时，底噪跟得上（否则关阈恒低于环境 ⇒ speaking 恒真 ⇒ 说完永不停）
    //   ② 用户持续小声说话时，底噪**不能**被拉高（否则说话被判成静音 ⇒ 误停）
    //
    // 做法（业界标准 · audio.js / Martin 最小统计量思路，但换成对语音更稳健的分位）：
    //   底噪 = 最近 OVB_NOISE_WINDOW 帧的 **p20 分位**，双向即时跟随，**不设速率上限**。
    //   · 为什么是分位而不是最小值：最小值会被「历史最低的一帧」永久钉死
    //     （实测：环境 0.005 但最小值停在 0.0003 ⇒ 关阈 0.0005 ⇒ 永远判成说话）。
    //   · 为什么是 p20 而不是中位数：10 s 窗口里人说话通常 <50%，p20 恰好落在安静档；
    //     若用中位数，说话占比高时会跟着语音一起漂。
    //   · 为什么不设速率上限：任何速率上限都会在「环境远高于初值」时拖慢跟随，
    //     而这正是现场失效的形态。分位本身已经抗尖峰，无需再限速。
    //   · 语音为什么不会污染 p20：单帧/短促尖峰只占窗口极小部分，进不了 p20。
    //     （A2 的恒定 0.018 之所以能通过，是因为它**填满**窗口 ⇒ p20 也变高 —— 
    //      那是「真的持续了 10 s 的稳定电平」，此时判为环境在语义上是对的，
    //      而用户早已停止说话。详见 docs/internal 的方案文档「E/A2 裁决」。）
    const trackFloor = (v, force) => {
      void force;   // 保留形参以兼容既有调用点（兜底路径已由分位本身覆盖）
      const sample = (v > measurableFloor()) ? v : measurableFloor();
      quietWindow.push(sample);
      if (quietWindow.length > OVB_NOISE_WINDOW) quietWindow.shift();
      const sorted = quietWindow.slice().sort(function (a, c) { return a - c; });
      const q = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * OVB_FLOOR_QUANTILE))];
      noiseFloor = q;
      applyFloor();
    };
    // §7.4：连续静音帧数按**当前配置值**动态计算
    // ⚠ R6（2026-11-12 · #15 后续）：此处原为**闭包一次性求值** —— 会话开始后用户改档位**不生效**，
    //   且与 `_internal.requiredQuiet()`（实时读配置）口径不一致（同一进程两个真相）。
    //   处置：改为每帧实时求值（纯对象属性访问，无 IO）。配置读取失败时回落 20 帧（= 默认 2s）。
    const requiredQuietNow = () => {
      try { return vadRequiredQuiet(vadSilenceMsOf(voiceCfgState.value)); }
      catch (e) { return 20; }
    };
    const tick = () => {
      if (stopped) return;
      // ⚠ SW-1b：会话**中途**把开关关掉 ⇒ 当帧起不再监测（开关对整场都为真，而非只在启动那一刻）。
      if (!ovbVadEnabled()) return;
      try {
        frames++;
        const rms = readRms();
        if (calibrating) {
          noiseSamples.push(rms);
          b.vadFrames = frames;
          b.vadPath = 'official';
          b.vadResolution = resolution;
          b.vadCalibrating = true;
          if (noiseSamples.length >= OVB_CALIBRATE_FRAMES) {
            calibrating = false;
            // 校准只给**初值**（中位数）。⚠ 校准窗**不保证落在静音里**（用户按下即开口）⇒
            //   初值可能被语音污染；此后由滑动最小值接管 —— 一旦出现更低的非语音帧
            //   （词间回落 / 随后停顿），底噪即回落到真实量级（= §7.4 自愈的本意，D 判据的落点）。
            //   ⚠ 改前这里还有 smoothRms = 0（清指数平滑残留）；本判据**不再用平滑值**判，
            //     该残留路径整体消失（F-2）。
            const sorted = noiseSamples.slice().sort(function (a, c) { return a - c; });
            const med = sorted[Math.floor(sorted.length / 2)];
            noiseFloor = (med > measurableFloor()) ? med : measurableFloor();
            applyFloor();
            b.vadCalibrating = false;
          }
          return;
        }
        // ── 帧判定（相对量；平滑已拆除）
        const isOn = rms >= vadThreshold;
        const isOff = rms < vadThresholdOff;
        // ── 语音确认 = **连续帧**确认（商用共性④：requires consecutive frames above threshold
        //   to trigger state changes, preventing spurious transitions）。
        //   为什么不是「窗口内凑够 N 帧」（本批实测否掉）：环境噪声起伏常是**方波式**
        //     （风扇/空调/桌面震动），档位一抬就是 2–3 帧，凑数照样能凑够 ⇒ 只有底噪也被确认成语音（C 反向坏）。
        //   为什么不是单帧：敲击/碰撞/单点量化跳变只有 1–2 帧。
        //   为什么 3 帧（300ms）够：真实音节的有声段 100–300ms+，包络峰肩就有 3 帧；
        //     字间回落会打断连续段 ⇒ 确认只看一个音节内是否持续有声，不跨音节。
        if (isOn) aboveRun++; else aboveRun = 0;
        if (aboveRun >= OVB_ONSET_RUN) {
          // 确认到语音：门打开，静音计数清零
          heardSpeech = true;
          quietFrames = 0;
        } else if (heardSpeech) {
          // ⚠ 这条 else if (heardSpeech) 是「从未说话 ⇒ 不得判停」的反向锁（VADSIL-P13 判它的字面形态）。
          // 状态机 + 迟滞（**这条是 A 判据的落点**）：
          //   只要本帧仍在**关阈**之上（>= 底噪，即迟滞带下沿）⇒ 说话态、静音帧清零；
          //   落到关阈以下 ⇒ 才计一帧安静。
          //   ⚠ 为什么说话态不能「只在开阈之上」才重建：小声续说的音节峰往往只略高于关阈
          //     （底噪 0.004 时约 0.010），它在开阈附近来回 ⇒ 若只认开阈，软语音会**永远**
          //     回不到说话态 ⇒ 每个音节都计静音帧 ⇒ 2 s 后照样判停（本批实测命中该形态）。
          //   ⇒「关阈 = 底噪」这一档才是"人还在说话"的判据；开阈只用于**首次确认**。
          speaking = !isOff;
          if (speaking) quietFrames = 0; else quietFrames++;
        }
        // 噪声底取样（门与阈值无关，见 trackFloor 注释）
        // ⚠ R4（2026-11-11 · #15）：门卡死超时兜底。判据仍是**与阈值无关**的取样门；
        //   兜底只在「连续 OVB_FLOOR_STALL_FRAMES 帧一次都没取样」时强制重估一次，
        //   门正常时 floorStall 每帧归零，兜底永不触发（既有 17 条 VAD 判据逐字不受影响）。
        // ⚠ 2026-11-12 (v5 · 现场实测修正)：取样门关闭时也必须喂窗口。
        //   病历（真实音频端到端实测）：环境 RMS ≈ 0.005 持续高于「底噪×1.6」，
        //   取样门**一直关闭** ⇒ quietWindow 永不更新 ⇒ mn 恒为旧底噪 ⇒ 常规路径追不上
        //   ⇒ 底噪卡在 0.0012、关阈 0.0018 恒低于环境 ⇒ speaking 恒真 ⇒ 说完永不停。
        //   ⇒ 修法：门关闭时仍把当前帧记入窗口（但**降权**：按门倍率折减），
        //     使滑动最小值能缓慢跟随真实环境；门开着时行为逐字不变。
        if (!(noiseFloor > measurableFloor()) || rms < noiseFloor * OVB_FLOOR_TRACK_RATIO) {
          trackFloor(rms, false);
          floorStall = 0;
        } else {
          floorStall++;
          // ⚠ 门关闭表示「本帧高于门限」。把它**折减**后喂窗口（取 rms 与门限的几何均值）：
          //   · 若只是语音尖峰 ⇒ 折减值仍远高于旧底噪，但由于窗口取最小值，不会立刻抬底噪；
          //   · 若环境**持续**偏高 ⇒ 折减值每帧都在窗口里，最小值会逐步上移直到追上环境。
          //   为何不直接喂 rms：那会让语音尖峰立刻污染底噪（旧缺陷）。
          //   为何不喂「noiseFloor × 门倍率」：那只是比旧底噪高 1.6 倍，追不上高出 4 倍的真实环境
          //     （现场实测：环境 0.005 vs 底噪 0.0013 ⇒ 卡死）。
          const gateLimit = noiseFloor * OVB_FLOOR_TRACK_RATIO;
          trackFloor(Math.sqrt(rms * gateLimit), false);
        }
        // ⚠ R4（2026-11-11 · #15）：兜底判据改为「**窗口稳健统计**」，不再依赖「门连续关闭多少帧」。
        //   病历（新增判据 OVB-VAD-15 实测）：真实说话有**字间回落**（典型每 2 帧回落一次到环境电平），
        //   回落帧会让取样门打开、把 floorStall 清零 ⇒ 「连续 30 帧门关闭」这个判据**永远不成立**
        //   ⇒ 兜底不触发 ⇒ 该用例仍永不判停（正是现场形态）。
        //   ⇒ 改为：每帧都把 rms 记进 stallRecent，用其**中位数**判断「环境是否整体高于底噪 × 门倍率」。
        //     中位数天然抗语音尖峰（语音占比 < 50% 时中位数即环境），也不受字间回落干扰。
        stallRecent.push(rms);
        if (stallRecent.length > OVB_FLOOR_STALL_CV_WINDOW) stallRecent.shift();
        if (stallRecent.length >= OVB_FLOOR_STALL_CV_WINDOW && noiseFloor > measurableFloor()) {
          // ⚠ 判据用**低分位**（不是中位数）：中位数在「语音占比高」的窗口里会被说话电平主导
          //   ⇒ SCEN_A（续说 30 s，语音占比 > 50%）会被误判为环境抬升 ⇒ 误停（OVB-VAD-14 实测转红）。
          //   低分位取的是「本窗口里最安静的那一档」：
          //     · 环境真抬升 ⇒ 连最安静的帧也高于旧底噪 × 倍率 ⇒ 该分位高 ⇒ 判定为抬升，重估成立；
          //     · 只是持续小声说话 ⇒ 字间回落帧仍低 ⇒ 该分位不高 ⇒ 不重估（声音照样被当语音，正确）。
          // ⚠ 判据用「**高于门的帧占比**」而不是分位数：
          //   环境整体抬升（如校准偏静、随后房间变吵）⇒ 几乎**每一帧**都高于旧门（占比→1）；
          //   持续小声说话 ⇒ 字间回落帧仍低于旧门（占比明显 < 1，SCEN_A 实测约 0.6）。
          //   E 用例（说话后环境恒定 0.005，门 = 0.002×1.6 = 0.0032）⇒ 环境段占比 = 1 ⇒ 重估触发。
          const gate = noiseFloor * OVB_FLOOR_TRACK_RATIO;
          let above = 0;
          for (let i = 0; i < stallRecent.length; i++) if (stallRecent[i] > gate) above++;
          // ⚠ 2026-11-12 (E/A2 conflict ruling): the rise-ratio alone is NOT enough.
          //   Measured fact (three-layer verification, see docs/internal plan doc):
          //     a CONSTANT level (0.018 or 0.02, CV = 0.000) is acoustically
          //     indistinguishable from 'user keeps talking quietly'; WebRTC 6-band log
          //     energies put them 0.516 apart while genuinely different sounds sit 44.8 apart.
          //   Ruling: keep A2 (never stop while the user may still be speaking; an early stop
          //     loses unrecoverable content) and require REAL ambient fluctuation for a rise.
          //     Real room noise always fluctuates (measured CV ~ 0.29); a perfectly flat level
          //     is a digital-silence / clipping artifact, not a room.
          //   => gate = above-ratio >= 0.9  AND  window CV >= OVB_FLOOR_RISE_MIN_CV.
          //   The CV guard inside trackFloor(force) is NOT sufficient: the regular path
          //   (noiseFloor = mn, sliding-window minimum) absorbs the flat level BEFORE the
          //   forced branch is ever reached. So the guard must live at the entry.
          // ⚠ 2026-11-12 (E/A2 ruling, final): the CV must be measured on the RECENT tail,
          //   not the whole window. Measured: right after speech ends the whole 30-frame window
          //   still holds tall speech frames, so CV ≈ 0.80 for BOTH flat and rippling tails;
          //   only once speech has scrolled out (≈25 frames) do they separate cleanly:
          //     flat tail CV = 0.000,  rippling tail CV ≈ 0.25.
          //   Using the tail keeps a flat hold from ever firing the forced re-estimate
          //   (protects 'do not cut off a user who is still talking'), while a real room
          //   still qualifies as soon as its own fluctuation dominates the window.
          if (above / stallRecent.length >= OVB_FLOOR_STALL_ABOVE_RATIO
              && stallTailCv() >= OVB_FLOOR_RISE_MIN_CV) {
            // ⚠ 抬升目标 = 窗口内**低分位**（= 当前环境里最安静的那一档），而不是「旧底噪 × 4」：
            //   后者在环境远高于校准值时要连续抬好几轮（实测 0.002 → 0.02 需 3 轮 = 3 s），
            //   而每轮之间还要重攒 30 帧窗口 ⇒ 判停被推迟到用例时间轴之外（E 判据实测转红）。
            //   直接用低分位既一步到位，又天然不会超过环境电平本身（所以仍不会被语音抬高）。
            const sortedStall = stallRecent.slice().sort(function (a, c) { return a - c; });
            const stallTarget = sortedStall[Math.min(sortedStall.length - 1,
              Math.floor(sortedStall.length * OVB_FLOOR_STALL_ABOVE_LOW_Q))];
            // 仍保留「不得超过旧底噪若干倍」的护栏，防单帧异常把底噪一击抬飞。
            const cap = noiseFloor * OVB_FLOOR_STALL_MAX_MULT;
            trackFloor(stallTarget < cap ? stallTarget : cap, true);
            floorStall = 0;
          }
        }
        // 读数出账（不得静默：逐帧反映**当下**，不是只记曾开过）
        // ⚠ R2（2026-11-12 · #15 后续）：每 10 帧（≈1 s）推一次 ovbNotify ——
        //   此前 tick 内零推送 ⇒ 用户在录音期间盯着诊断区看，数字一动不动（「让失败不可观测」类）。
        //   节流而非逐帧：React 订阅方每秒重渲染 1 次足够，逐帧（10 次/秒）纯浪费。
        if (frames % 10 === 0) ovbNotify();
        b.vadHeardSpeech = heardSpeech;
        b.vadSpeaking = speaking;
        b.vadQuietFrames = quietFrames;
        b.vadThreshold = vadThreshold;
        b.vadThresholdOff = vadThresholdOff;
        b.vadNoiseFloor = noiseFloor;
        b.vadFrameSpeech = isOn;
        b.vadRms = rms;
        b.vadSnr = (noiseFloor > 0) ? (rms / noiseFloor) : 0;
        b.vadResolution = resolution;
        b.vadPath = 'official';
        b.vadPathErrors = pathErrors;
        b.vadFrames = frames;
        b.vadCalibrating = false;
        if (quietFrames >= requiredQuietNow()) { stopped = true; onSilence(); }
      } catch (e) { /* 单帧失败忽略 */ }
    };
    let stop = null;
    if (b.timerSvc && typeof b.timerSvc.interval === 'function') {
      const disposer = b.timerSvc.interval(tick, OVB_POLL_MS);
      stop = () => { try { if (typeof disposer === 'function') disposer(); } catch (e) { /* 忽略 */ } };
    } else {
      const id = setInterval(tick, OVB_POLL_MS);
      stop = () => { try { clearInterval(id); } catch (e) { /* 忽略 */ } };
    }
    return () => {
      stopped = true;
      try { if (stop) stop(); } catch (e) { /* 忽略 */ }
      try { if (ctx && ctx.state !== 'closed') ctx.close(); } catch (e) { /* 忽略 */ }
    };
  } catch (e) {
    try { if (ctx && ctx.state !== 'closed') ctx.close(); } catch (e2) { /* 忽略 */ }
    b.abandonReason = 'vad-init-failed';
    return null;
  }
}

// ── 官方相位观察（只读官方渲染出来的 DOM 属性，不注入/不改官方）──────────────
function ovbWatchActivity() {
  const b = ovbBus();
  if (!b || typeof document === 'undefined' || typeof document.querySelector !== 'function') return;
  if (typeof MutationObserver !== 'function') return;
  let everMounted = false;
  let wasFeedback = false;
  // ⚠ B-5（本批）：本会话是否**已完成收口**（settleMiss + lastEndedAt）。
  //   feedback 分支与「节点消失」分支都会收口 ⇒ 用同一标志保证**恰好一次**（否则会重复计 missed）。
  let settled = false;
  // ⚠ 竞态修复（CDP 实测命中）：官方相位属性出现（requesting）**早于** `getUserMedia` 包装的
  //   `.then()` 落地（实测排序：phase@+18ms → firstCallAt@+30ms）。旧实现在**相位上升沿那一刻**
  //   快照 `firstCallAt === 0` 就永久计 missed ⇒ **真命中被误判为未命中**（实测该形态下 firstCallAt>0
  //   与 sessionsMissed=1 同时成立，诊断区会误报「未观测到官方采集」= 掩盖问题）。
  //   现改为**会话收口时按调用计数判定**：会话结束时若计数与开始时**相同**（整场一次都没被调用过）
  //   ⇒ 才计 missed。计数只增不减 ⇒ 既免疫「相位先到、包装后落地」的上升沿竞态，
  //   也免疫「本次调用来得极晚（会话结束之后才落地）」的形态（两者均被 CDP 实测命中）。
  const settleMiss = () => {
    const now = b.callCount || 0;
    // 窗口语义：自**上一次会话收口**以来包装器是否被调用过。
    // 为何不用「上升沿快照」（本批 CDP 实测两次命中不同形态的误报）：
    //   ① 相位先到、调用后到（delta 在收口时已 >0，尚可）；
    //   ② **调用先到、相位后到**（实测：callCount 在相位出现时就已是 1）⇒ 上升沿快照把 delta 记成 0，
    //      收口时判「没调用过」= 真命中被误报为 missed。
    // 用「上次收口以来的计数窗口」则与相位/调用的先后顺序无关：本次会话期间只要发生过调用，窗口必变。
    if (now === (b.callCountAtPrevSessionEnd || 0)) {
      b.sessionsMissed++;
      b.lastMissedAt = Date.now();
    }
    b.callCountAtPrevSessionEnd = now;
  };
  // 只读官方失败出口的文案（`.activityMessage`）供诊断区显示，绝不写回
  const readFeedbackMessage = () => {
    try {
      const scope = '[' + OVB_ACTIVITY_ATTR + '="' + OVB_FEEDBACK_PHASE + '"] ';
      const node = document.querySelector(scope + OVB_MESSAGE_CLASS_ATTR)
        || document.querySelector(scope + '.' + OVB_MESSAGE_CLASS);
      const txt = node && typeof node.textContent === 'string' ? node.textContent : '';
      return txt.slice(0, 120);
    } catch (e) { return ''; }
  };
  // 官方相位观察（只读官方渲染出来的 DOM）。收口（settleMiss + lastEndedAt）由 `settled` 保证**恰好一次**。
  const sync = () => {
    const present = !!document.querySelector('[' + OVB_ACTIVITY_ATTR + ']');
    const rec = document.querySelector('[' + OVB_ACTIVITY_ATTR + '="' + OVB_RECORDING_PHASE + '"]');
    const fb = document.querySelector('[' + OVB_ACTIVITY_ATTR + '="' + OVB_FEEDBACK_PHASE + '"]');
    // 记录当前相位（诊断用；idle = 节点已卸载 ⇒ 空串）
    if (fb) b.lastPhase = OVB_FEEDBACK_PHASE;
    else if (rec) b.lastPhase = OVB_RECORDING_PHASE;
    else if (present) b.lastPhase = 'active';
    else b.lastPhase = '';
    // ── 官方 `feedback` 相位（B-3）─────────────────────────────
    // 它**不是**「识别失败」专用出口：官方 `client.js:4990-5026` 实读 ——
    //   `feedback()` 只在**转写已完成之后**调用：
    //   `tooLarge` / 转写失败 / `text === ""`（未识别到语音）/ **`insertText` false**
    //   （草稿冲突；此时转写是**成功**的）。
    // 旧实现把整支当失败并直接 return ⇒ **跳过会话收口**：
    //   `settleMiss` 不计、`lastEndedAt` 永不更新 ⇒ **自动增强永不触发**（实测：E1）。
    // 现在：读数照旧记（`endedInFeedback` 保留 = 订阅方不空等写回），但**同步完成一次收口**。
    // ⚠ `b.active` 在此**保持为真**：官方此时仍占用语音入口（开始按钮不渲染），
    //   若置 false，热键再按会走 `start-button-not-found` 并写 `abandonReason`
    //   ⇒ 诊断区第二优先分支会**盖掉**本条 feedback 文案（又一处会掩盖问题）。
    if (fb) {
      if (!everMounted) {
        everMounted = true;
        settled = false;
        b.sessionsStarted++;
        ovbNotify();
      }
      b.endedInFeedback = true;
      if (!wasFeedback) {
        wasFeedback = true;
        b.feedbackSeen++;
        b.lastSessionFailed = true;   // CHG-090：最近一次会话以失败出口收口
        b.lastFeedbackAt = Date.now();
        b.feedbackMessage = readFeedbackMessage();
        if (!settled) { settled = true; settleMiss(); b.lastEndedAt = Date.now(); }
        ovbNotify();
      }
      return;   // 已收口：等待用户关闭（X）或重试
    }
    if (!fb && wasFeedback) {
      // ⚠ CHG-090：**先**判是否「官方仍在挂载」——它区分两种离开 feedback 的形态：
      //   ① `present` 仍为真 = 官方「重新录音」（新会话已开始）⇒ 最近一次会话**不再是**那场失败 ⇒ 复位；
      //   ② `present` 为假 = 用户点 X 关闭 ⇒ 最近一次会话**确实**以失败收口 ⇒ **保留**读数（不得静默失效）。
      if (present) b.lastSessionFailed = false;
      wasFeedback = false;
      // ⚠ B-4（本批实测）：离开 feedback 相位（官方「重新录音」或 X）必须复位标志，
      //   否则相位已回到 recording 而诊断仍报「上次官方会话以失败收场」（实测：E3）。
      b.endedInFeedback = false;
      // ⚠ 未识别态批（2026-10-15 · 需求 1「未识别态触发 ⇒ **能重新启动一轮**」）：
      //   官方「重新录音」是**相位内换会话**（captureRow 节点不卸载 ⇒ `everMounted` 仍为 true）
      //   ⇒ 上一轮在 feedback 分支已把 `settled` 置 true 且**无人复位**
      //   ⇒ 新一轮**永不收口**：settleMiss 不计、`lastEndedAt` 不更新
      //   ⇒ 自动增强不触发、诊断读数停在上一次（「能重启一轮」等于落空）。
      //   故在此**显式开启新一轮**（仅当确实回到了活跃相位；点 X 时 present 为假 ⇒ 不开）。
      //   ⚠ 与 CHG-085 收口语义一致：feedback 那一轮**已经**收口（不重复计 missed / 不重写时刻），
      //     这里开的是**下一轮**，不是把未识别态当成采集成功。
      if (present) {
        settled = false;
        everMounted = true;
        b.sessionsStarted++;
        b.active = true;
      }
    }
    // 新会话上升沿（含从 feedback 重试：上一会话已收口 ⇒ everMounted 已落）
    if (present && !everMounted) {
      everMounted = true;
      settled = false;
      b.sessionsStarted++;
      b.active = true;
      b.endedInFeedback = false;
      b.lastSessionFailed = false;   // CHG-090：新会话开始 ⇒ 上一场的失败不再是「最近一次」
      ovbNotify();
    }
    if (present && !rec) b.active = true;
    // 会话收口（相位节点消失）
    if (!present && everMounted) {
      everMounted = false;
      b.active = false;
      // ⚠ missed 判定放在**会话收口**处（不是上升沿）：见 settleMiss 注释（竞态修复）。
      // ⚠ B-5：feedback 分支已收口时（settled）**不得**重复收口 —— 否则 missed 被计两次。
      // ⚠ 未识别态批（2026-10-15 · 自查发现的既有缺陷）：下方 `_alreadySettledBeforeGone` 原用共享的 `settled`，
      //   而本分支**刚刚**把 `settled` 置 true ⇒ 该判据恒为真 ⇒ 自第 2 场会话起
      //   `lastEndedAt` **永不更新**（自动增强每页只能装臂一次）。
      //   现先快照「本会话是否**已**在 feedback 分支收口」—— 它才是该判据本来想表达的东西。
      //   ⚠ 语义不变：feedback 已收口 ⇒ 仍不重写时刻（OVB-F01b）；普通收尾 ⇒ 照旧记时刻（OVB-F02）。
      const settledInFeedback = settled;
      if (!settled) { settled = true; settleMiss(); }
      // 官方会话结束 ⇒ 记结束时刻（自动增强的订阅方据此在写回落地后触发）。
      //   若 feedback 分支已写过同一会话的时刻 ⇒ 不覆盖（保持首次收口时间，避免订阅方重复装臂）。
      //   ⚠ 若本会话已在 feedback 分支收口 ⇒ 保留该时刻（不重写），保证订阅方不重复装臂。
      const _alreadySettledBeforeGone = settledInFeedback;
      // ⚠ CHG-090：**成功**收口（节点消失、且不是 feedback 分支已收口的那场）⇒ 最近一次会话未走失败出口。
      //   判据用 `_alreadySettledBeforeGone`：feedback 已收口时**不得**把它抹掉。
      if (!_alreadySettledBeforeGone) b.lastSessionFailed = false;
      if (!_alreadySettledBeforeGone) b.lastEndedAt = Date.now();
      ovbNotify();
      b.endedInFeedback = false;
    }
  };

  try {
    const mo = new MutationObserver(sync);
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: [OVB_ACTIVITY_ATTR] });
    sync();
  } catch (e) { /* 观察失败不致命：诊断区另有包装器调用状态 */ }
}

// ── 安装（幂等）：只包一次；重复安装不叠层 ───────────────────────────────────
function installOfficialVoiceBridge() {
  const b = ovbBus();
  if (!b) return false;
  if (b.installed) return false;                      // 幂等：已装即返回，绝不叠层
  if (ovbDisabled()) { b.abandonReason = 'disabled-by-flag'; return false; }
  if (typeof document === 'undefined' || typeof document.querySelector !== 'function') {
    b.abandonReason = 'no-document';
    return false;
  }
  // 2026-11-12 (#15 architectural change): install NO LONGER wraps any global API.
  // The old form replaced navigator.mediaDevices.getUserMedia; on the user's real machine
  // that wrapper was never called (callCount=0), and a DSH restart does not reload an
  // already-open browser page, so the wrapper was simply absent. That whole path is gone:
  // we now observe the officially rendered activity container and read the official
  // Recording instance out of it. Nothing global is patched, so nothing can leak or
  // fail to restore, and install timing no longer matters.
  const probe = (typeof officialRecordingProbe !== 'undefined' && officialRecordingProbe
    && typeof officialRecordingProbe.probeOfficialRecording === 'function')
    ? officialRecordingProbe.probeOfficialRecording
    : null;
  if (!probe) { b.abandonReason = 'recording-probe-unavailable'; return false; }

  let vadStop = null;
  let vadSessionActive = false;

  // Drive one VAD session off the official Recording instance.
  // Detects the recording->non-recording transition and tears the session down.
  const syncSession = () => {
    // ⚠ 2026-11-12 (#15 arch change): self-capture (hotkey owns the mic) must keep us out,
    //   exactly as the old getUserMedia wrapper did via ovbSelfCapturing(). Losing this check
    //   would let the plugin open a second VAD session over a capture it does not own.
    if (ovbSelfCapturing()) return;
    const res = probe(OVB_ACTIVITY_ATTR, document);
    const recordingPhase = (res && res.phase === OVB_RECORDING_PHASE);
    const live = !!(res && res.found && res.recording);
    if (live && recordingPhase && !vadSessionActive) {
      // Session start: clear the previous session's demotion reason, then open a VAD.
      b.abandonReason = '';
      // 2026-11-12 (#15 arch change): do NOT clear b.recording here.
      //   Under the old wrapper the recorder was captured by the getUserMedia path, which ran
      //   AFTER this point, so clearing was harmless. Now the recorder is captured independently
      //   (ovbWrapRecorder sees the official recorder construction), and it may well have been
      //   captured BEFORE the session becomes visible — clearing here would throw that reference
      //   away and the A2 fallback stop would then report no-stop-button-and-no-recorder
      //   (measured). The reference is already cleared on recorder stop and on uninstall.
      if (!ovbVadEnabled()) { b.vadSkipped = (b.vadSkipped || 0) + 1; ovbNotify(); return; }
      vadSessionActive = true;
      const rec = res.recording;
      const getAmp = () => (typeof rec.amplitude === 'function' ? rec.amplitude() : 0);
      b.callCount = (b.callCount || 0) + 1;
      b.firstCallAt = b.firstCallAt || Date.now();
      b.lastCallAt = Date.now();
      if (vadStop) { try { vadStop(); } catch (e) { /* ignore */ } vadStop = null; }
      vadStop = ovbStartVad(getAmp, () => {
        const r = ovbStopOfficial();
        if (r.via === 'no-active-session') return;
        if (!r.stopped && !b.abandonReason) b.abandonReason = 'silence-detected-stop-unavailable';
      });
      if (!vadStop) vadSessionActive = false;
      ovbNotify();
      return;
    }
    if (vadSessionActive && (!live || !recordingPhase)) {
      vadSessionActive = false;
      if (vadStop) { try { vadStop(); } catch (e) { /* ignore */ } vadStop = null; }
      ovbNotify();
    }
  };

  try {
    const mo = new MutationObserver(syncSession);
    mo.observe(document.body, {
      childList: true, subtree: true,
      attributes: true, attributeFilter: [OVB_ACTIVITY_ATTR],
    });
    b.sessionObserver = mo;
  } catch (e) {
    b.abandonReason = 'session-observer-failed';
    return false;
  }

  b.installed = true;
  // ⚠ 2026-11-12: the MediaRecorder fallback is INDEPENDENT of the VAD data source.
  //   It is only used when the official stop button cannot be found (A2 path), so it must
  //   keep being installed — dropping it here silently removed the documented fallback.
  ovbWrapRecorder();
  ovbWatchActivity();
  ovbNotify();
  syncSession();
  return true;
}

// ── 兜底包装：捕获官方 MediaRecorder 实例（仅在官方停止按钮不可用时才用它停）────
// 官方以**裸全局** `new MediaRecorder(stream)` 构造（官方 client.js:4701，全文无局部绑定）
// ⇒ 解析到本包装 ⇒ `inst.start` patch 后记录实例（真实实现构造态为 inactive，start 后才 recording）。
function ovbWrapRecorder() {
  const b = ovbBus();
  if (!b || b.wrappedRecorder) return;
  if (typeof window === 'undefined' || typeof window.MediaRecorder !== 'function') return;
  const Orig = window.MediaRecorder;
  function WrappedRecorder() {
    const inst = new Orig(...arguments);
    try {
      // ⚠ 捕获时机：真实 `new MediaRecorder(stream)` 构造后 state 为 `inactive`，
      //   **只有 start() 之后**才是 `recording` ⇒ 必须在 start() 上挂钩才会拿到实例
      //   （仅按构造态判断会永久漏捕 ⇒ 实测被 OVB-P01 抓到）。
      //   构造态已是 recording 的实现（非常规）一并兜住。
      const st = inst.state;
      if (st === 'recording' || st === undefined) b.recording = inst;
      const origStart = inst.start;
      if (typeof origStart === 'function') {
        inst.start = function () {
          const r = origStart.apply(this, arguments);
          try { if (inst.state === 'recording') b.recording = inst; } catch (e0) { /* 忽略 */ }
          return r;
        };
      }
      // 官方收尾（自身 stop / 手动停 / 上限停）后清引用，防陈旧句柄被再次 stop
      const clearIfSelf = () => { if (b.recording === inst) b.recording = null; };
      if (typeof inst.addEventListener === 'function') {
        inst.addEventListener('stop', clearIfSelf);
      } else if ('onstop' in inst) {
        const prev = inst.onstop;
        inst.onstop = function () { try { if (prev) prev.apply(this, arguments); } finally { clearIfSelf(); } };
      }
    } catch (e) { /* 捕获失败不影响官方实例本身 */ }
    return inst;
  }
  WrappedRecorder.prototype = Orig.prototype;
  for (const k of ['isTypeSupported']) { if (typeof Orig[k] === 'function') WrappedRecorder[k] = Orig[k].bind(Orig); }
  try { window.MediaRecorder = WrappedRecorder; } catch (e) {
    b.abandonReason = 'media-recorder-wrap-failed';
    return;
  }
  b.originalRecorder = Orig;
  b.wrappedRecorder = true;
}

// 卸载 / HMR：恢复原函数（同一性：恢复后 === 原函数），并把命名空间复位
function uninstallOfficialVoiceBridge() {
  const b = ovbBus();
  if (!b) return false;
  // 2026-11-12 (#15 architectural change): no getUserMedia wrapper to restore any more.
  // Only the session observer (added by install) and the recorder fallback need teardown.
  if (b.sessionObserver) {
    try { b.sessionObserver.disconnect(); } catch (e) { /* ignore */ }
    b.sessionObserver = null;
  }
  if (b.wrappedRecorder && b.originalRecorder) {
    try { window.MediaRecorder = b.originalRecorder; } catch (e) { /* 忽略 */ }
  }
  // ⚠ 必须复位录制器包装态：否则「卸载→再安装」时 ovbWrapRecorder 会被 wrappedRecorder 挡掉，
  //   导致 HMR 反复挂载后兜底捕获永久失效（实测被 OVB-U03 抓到）。
  b.wrappedRecorder = false;
  b.originalRecorder = null;
  b.installed = false;
  b.firstCallAt = 0;
  b.lastCallAt = 0;
  b.callCount = 0;
  b.callCountAtPrevSessionEnd = 0;
  b.recording = null;
  b.active = false;
  b.abandonReason = '';
  b.lastPhase = '';
  b.startClicks = 0;
  b.startMissed = 0;
  b.lastStartMissedAt = 0;
  b.stopClicks = 0;
  b.stopMissed = 0;
  b.retryClicks = 0;
  b.lastStartVia = '';
  b.feedbackSeen = 0;
  b.lastSessionFailed = false;
  b.lastFeedbackAt = 0;
  b.feedbackMessage = '';
  b.endedInFeedback = false;
  b.vadHeardSpeech = false;
  b.vadQuietFrames = 0;
  b.vadThreshold = 0;
  b.vadNoiseFloor = 0;
  b.vadSkipped = 0;
  b.vadFrameSpeech = false;
  b.vadSpeaking = false;
  b.vadRms = 0;
  b.vadSnr = 0;
  b.vadThresholdOff = 0;
  b.vadResolution = 0;
  b.vadPath = '';
  b.vadPathErrors = 0;
  b.vadFrames = 0;
  b.vadCalibrating = true;
  ovbNotify();
  return true;
}

// 官方将来新增钩子 ⇒ 停用包装、优先用官方（§4.6.2.6 D 第 4 行 / UD-0005 总纲）
// 探针 = 官方是否把「静音/自动停」做成正式能力（官方导出面或 remote 方法出现该语义）
function ovbOfficialHookPresent() {
  try {
    if (typeof window === 'undefined') return false;
    const probe = window.__dshSpeechVoiceActivityHook;
    return !!(probe && (typeof probe === 'function' || typeof probe === 'object'));
  } catch (e) { return false; }
}
function ovbYieldToOfficialIfPresent() {
  const b = ovbBus();
  if (!b || !b.installed) return false;
  if (!ovbOfficialHookPresent()) return false;
  uninstallOfficialVoiceBridge();
  b.abandonReason = 'yielded-to-official-hook';
  ovbNotify();
  return true;
}

const officialVoiceBridge = {
  OVB_REGION,
  install: installOfficialVoiceBridge,
  uninstall: uninstallOfficialVoiceBridge,
  snapshot: ovbSnapshot,
  subscribe: ovbSubscribe,
  setTimer: (t) => { const b = ovbBus(); if (b) b.timerSvc = t || null; },
  setSelfCapture: ovbSetSelfCapture,
  officialCapturing: ovbOfficialCapturing,
  // 未识别态批（2026-10-15）：与 officialCapturing **语义不同**的读数 —— 官方是否仍占用语音入口
  //   （含收尾/未识别态）。CHG-085 收口语义与诊断面依赖它；不得与「采集中」混用。
  officialEntryBusy: ovbOfficialEntryBusy,
  startOfficial: ovbStartOfficial,
  stopOfficial: ovbStopOfficial,
  yieldToOfficialIfPresent: ovbYieldToOfficialIfPresent,
  _internal: {
    START_LABELS: OVB_START_LABELS,
    STOP_LABELS: OVB_STOP_LABELS,
    // §7.4：静音帧数现由配置动态计算（不再是常量）⇒ 对外暴露**计算入口**，供测试与运行期核对
    requiredQuiet: () => vadRequiredQuiet(vadSilenceMsOf(voiceCfgState.value)),
    ACTIVITY_ATTR: OVB_ACTIVITY_ATTR,
    FEEDBACK_PHASE: OVB_FEEDBACK_PHASE,
    RECORDING_PHASE: OVB_RECORDING_PHASE,
    bus: ovbBus,
    findStartButton: ovbFindStartButton,
    findRetryButton: ovbFindRetryButton,
    RETRY_LABELS: OVB_RETRY_LABELS,
    findStopButton: ovbFindStopButton,
    // N-1 判据基元：官方当前是否确在录音（只读官方相位属性）——供测试与运行期核对
    recordingNow: ovbRecordingNow,
  },
};


  return officialVoiceBridge;
}

module.exports = { createOfficialVoiceBridge };
