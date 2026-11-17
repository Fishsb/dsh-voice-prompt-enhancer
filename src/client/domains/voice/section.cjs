'use strict';

// 语音设置区块普通模块（构建期由客户端运行时内联）。
// 诊断组件与设置区块的可见文案、类名、ARIA 和交互不变。
function createVoiceSection(deps) {
  const d = deps && typeof deps === 'object' ? deps : {};
  const rpcMethods = d.rpcMethods && typeof d.rpcMethods === 'object' ? d.rpcMethods : {};
  const React = d.React;
  const makeT = d.makeT;
  const host = d.host;
  const voiceCfgState = d.voiceCfgState;
  const subscribeVoiceConfig = d.subscribeVoiceConfig;
  const saveVoiceCfg = d.saveVoiceCfg;
  const syncVoiceFromHost = d.syncVoiceFromHost;
  const vadSilenceMsOf = d.vadSilenceMsOf;
  const normalizeVadSilenceMs = d.normalizeVadSilenceMs;
  const CollapsibleSection = d.CollapsibleSection;
  const voiceHotkeyDisplay = d.voiceHotkeyDisplay;
  const officialVoiceBridge = d.officialVoiceBridge;
  const fillerSnapshot = d.fillerSnapshot;
  const subscribeFiller = d.subscribeFiller;
  const correctionSnapshot = d.correctionSnapshot;
  const subscribeCorrection = d.subscribeCorrection;
  const setTimeout = d.setTimeout;
  const clearTimeout = d.clearTimeout;
  const window = d.window;
// v3.2.5（语音识别模块）：设置段落块——「模型配置」tab 内可折叠段落（collapsible-section 样式）。
// P1-a（2026-10-13 缩批）：**引擎/云端/模型下载/运行时部署** 各段已退役（识别交官方
//   speech-to-text，其引擎与模型由官方设置页管理；插件不再持有 asr.cloud/local 面）。
//   本段只保留**四项增值**的配置：① 自动增强 ② 静音监测（VAD）③ 热键 ④ 文本规整（refine）。
// 交互：字段 blur/change 即 config/set（无保存按钮）；快捷键录制 blur/失焦取消。
// P2-补做（2026-10-13 · §4.6.2.6 D）：不得静默失效——官方录音路径增值对齐的**设置页诊断区**。
// 判据形态：若某次官方录音会话中包装器**从未被调用** ⇒ 必须在此处可见
// （「未观测到官方采集（自动停未生效）」）——不是只写日志。
// 2026-10-17：把「上次失败」的时刻折算成可读时距（给诊断文案用）。
//   ⚠ 只读、纯函数；无时刻（0/非法）⇒ 返回''，由调用方退化为不带时距的写法。
// UD-0052（2026-11-08 · 语音四件收口批）：档位候选 = 契约 `MODE_VALUES`（五项）。
//   ⚠ 名称一律走既有 `modeLabel*` i18n 键（⛔ 不新写模式名）。
//   ⚠ 用 `typeof` 守卫而非直接引用依赖名：本文件被 `factoryBody()` 求值时**依赖声明段被裁掉**
//     （边界 = `function ` 之后第一个 `//`），故依赖标识符只在装配层可见；未注入时退回契约同值字面量。
const ENHANCE_MODE_VALUES = typeof MODE_VALUES !== 'undefined' && Array.isArray(MODE_VALUES) && MODE_VALUES.length > 0
  ? MODE_VALUES
  : ['base', 'lite', 'standard', 'smart', 'publish'];
// ⚠ PE-32 修复（2026-11-17 · 全功能审查 medium）：**时距文案必须走 i18n**。
//   病历：本函数硬编码「刚刚 / N 分钟 / N 小时 / N 天」⇒ EN 界面实测出现
//     `title="... 40 天前"` 这类中英混排（键集 332=332 完全相等，问题在**值面硬编码**）。
//   修法：接受 `t`（缺省回退中文，供无 t 的旧调用点），单位改走 `voiceAgoJustNow` /
//     `voiceAgoMinutes` / `voiceAgoHours` / `voiceAgoDays` 四个键（ZH/EN 各一条）。
function ovbSinceLabel(at, t) {
  if (!at || typeof at !== 'number') return '';
  var d = Date.now() - at;
  if (d < 0) return '';
  var tt = (typeof t === 'function') ? t : function (k) { return (k === 'voiceAgoJustNow' ? '刚刚' : (k === 'voiceAgoMinutes' ? '{n} 分钟' : (k === 'voiceAgoHours' ? '{n} 小时' : '{n} 天'))); };
  var m = Math.floor(d / 60000);
  if (m < 1) return tt('voiceAgoJustNow');
  if (m < 60) return tt('voiceAgoMinutes').replace('{n}', String(m));
  var h = Math.floor(m / 60);
  if (h < 24) return tt('voiceAgoHours').replace('{n}', String(h));
  return tt('voiceAgoDays').replace('{n}', String(Math.floor(h / 24)));
}
function OfficialVoiceDiag(props) {
  const t = makeT(props);
  const [snap, setSnap] = React.useState(function () {
    return (typeof officialVoiceBridge !== 'undefined' && officialVoiceBridge) ? officialVoiceBridge.snapshot() : null;
  });
  React.useEffect(function () {
    if (typeof officialVoiceBridge === 'undefined' || !officialVoiceBridge) return undefined;
    const refresh = function () { setSnap(officialVoiceBridge.snapshot()); };
    refresh();
    return officialVoiceBridge.subscribe(refresh);
  }, []);
  if (!snap) return null;
  // 官方将来新增钩子 ⇒ 停用包装、优先用官方（总纲）
  if (typeof officialVoiceBridge !== 'undefined' && officialVoiceBridge
    && typeof officialVoiceBridge.yieldToOfficialIfPresent === 'function') officialVoiceBridge.yieldToOfficialIfPresent();
  // ⚠ D-1（空床假阳性修复）：**官方会话次数为 0** 时必须与「已验证」**可区分** ——
  //   旧末支（else = 「已就绪（等待官方录音）」）在 0 次会话时同样成立 ⇒ 与「官方路径已验证」同形
  //   （这正是「把『桥已装好』误读为『官方路径没问题』」的来源）。现按**会话计数**分支：
  //   0 次 ⇒ 明说「尚未观测到」；≥1 次且空闲 ⇒ 报「已观测到 N 次」。
  // ⚠ D-2（selfCapture 分支缺失修复）：外部显式声明自采中须可见（不得留描述不存在能力的串）。
  let text;
  let cls = 'dsh-plg-note';
  if (!snap.installed) { text = t('voiceOfficialDisabled'); cls = 'dsh-plg-note dsh-plg-upd-outdated'; }
  // 2026-10-17（文案改白话）：abandonReason 是**内部代码**（如 stop-click-dispatch-failed），
  //   不是给普通用户看的话 ⇒ 从可见文案移到 title（原始读数仍在，排查不受影响）。
  else if (snap.abandonReason) { text = t('voiceOfficialAbandon'); cls = 'dsh-plg-note dsh-plg-upd-outdated'; }
  else if (snap.selfCapture) { text = t('voiceOfficialSelfCapture'); }
  else if (snap.startMissed > 0 && snap.sessionsStarted === 0) { text = t('voiceOfficialStartMissed'); cls = 'dsh-plg-note dsh-plg-upd-outdated'; }
  else if (snap.endedInFeedback) { text = t('voiceOfficialFeedback') + (snap.feedbackMessage ? '（' + snap.feedbackMessage + '）' : ''); cls = 'dsh-plg-note dsh-plg-upd-outdated'; }
  else if (snap.sessionsMissed > 0) { text = t('voiceOfficialMissed'); cls = 'dsh-plg-note dsh-plg-upd-outdated'; }
  // ⚠ SW-1（2026-10-15 接线批 · 用户可见开关不得说假话）：开关关闭态**必须可见** ——
  //   否则关掉「静音监测」后诊断会落到「已就绪（等待官方录音）」，读起来像「正在监测、只是还没触发」。
  //   ⚠⚠ **位置纪律（本席自查修正）**：必须排在**所有失效/异常分支之后** ——
  //     `abandonReason`（降级）/ `startMissed`（热键启动失败）/ `endedInFeedback`（失败出口）/ `sessionsMissed`（包装未命中）
  //     都是「不得静默失效」面。若开关态排在它们**之前**，用户一旦关掉开关，这些**真实故障会被永久掩蔽**
  //     （实测：关掉开关后「热键启动失败」也显示成「静音监测已关闭」，用户会以为是自己设置导致、实则热键坏了）。
  //   ⚠ 只排在**正常/瞬态**分支（`recording`/`feedbackSeen`/`sessionsStarted`/`armed`）之前：
  //     那些不是故障，而「开关到底关没关」正是用户此刻的疑问 ⇒ 开关态优先作答。
  else if (snap.vadEnabled === false) { text = t('voiceSilenceOff'); cls = 'dsh-plg-note dsh-plg-upd-outdated'; }
  // ⚠ R1（2026-11-12 · #15 后续）：「VAD 在跑但门从未开过」必须有**独立可见态** ——
  //   此前该形态与正常态共用「官方采集进行中」⇒ 用户「设为 ON 2 秒、等很久不停」时界面完全正常
  //   （「让失败不可观测」类）。判据三条件：VAD 真的在跑（frames>0，排除没启动/被跳过）+
  //   门从未开过（heardSpeech=false）+ **会话已结束**（不在录）——录音中用户可能马上开口，
  //   过早下结论会闪红；结束后才是结论。位置：排在开关关闭之后（失效面纪律）、采集中之前。
  else if (snap.recording) { text = t('voiceOfficialActive'); }
  else if ((snap.vadFrames || 0) > 0 && !snap.vadHeardSpeech) { text = t('voiceOfficialVadSilent'); cls = 'dsh-plg-note dsh-plg-upd-outdated'; }
  // ⚠ CHG-090（2026-10-15 诊断如实化批）：此前判据是 `snap.feedbackSeen > 0` —— 而它是**页面生命期累计**
  //   （唯一自增点在 feedback 收口；`= 0` 只在 uninstall）⇒ 文案「**上次**官方会话以失败收场」实为「**历次累计发生过**」
  //   且**永不自消**（刷新/HMR 才归零）⇒ 把**历史残留**读成**当前失败**（用户最初报障看到的那行正由此而来）。
  //   现改用**会话级**读数 `lastSessionFailed`（最近一次已收口会话是否走失败出口）：
  //   ① 最近一次**真的**以失败收口 ⇒ 仍为真 ⇒ **仍然可见**（不得静默失效）；
  //   ② 之后录了一场**成功**会话 / 官方「重新录音」开了新会话 ⇒ 复位 ⇒ 不再报陈年旧事。
  // ⚠⚠ 2026-10-17（设置文案审查批 · 用户第二轮报障 D）：该分支依据 lastSessionFailed，而它的复位
  //   条件只有「之后录了一场成功会话」⇒ 很久没录音就一直挂着陈年失败。本批给它**时间可判性**：
  //   · 刚失败（< 24h）⇒ 报「刚刚」；
  //   · 很久以前（≥ 24h）⇒ 报「上次录音没有识别成功（{when}前）」，把时距直接写在可见文案里；
  //   · 之后成功过 ⇒ lastSessionFailed 已被桥复位为 false，本分支不进入（第三态由桥保证）。
  //   ⛔ 不得因此把失败吞掉：三态里前两态都仍然可见，且原始时刻留在 title（lastFailAt=）。
  else if (snap.lastSessionFailed === true) {
    // ⚠ 时距取不到（脏快照 / 老桥无该字段）时**退化为不带时距的写法** —— 不得渲染出「（前）」这类残句。
    const ago = ovbSinceLabel(snap.lastSessionFailedAt, t);
    text = ago ? t('voiceOfficialFeedbackSeenAgo').replace('{when}', ago) : t('voiceOfficialFeedbackSeen');
  }
  // F-11 修复（2026-10-13）：键内已含占位符 ⇒ 此处**代入**而不再追加第二个计数
  //   （旧实现 key 含 %d 未替换、此处又追加一个括号计数 ⇒ 用户可见 `…（共 %d 次）（1）`）。
  else if (snap.sessionsStarted > 0) { text = t('voiceOfficialVerified').replace('{n}', String(snap.sessionsStarted)); }
  else { text = t('voiceOfficialArmed'); }
  // title 兼作「原始读数」出口：官方失败出口文案 / 派发点击计数 / 包装调用计数（排查用）
  const diagTitle = [snap.feedbackMessage, snap.abandonReason,
    'sessions=' + snap.sessionsStarted, 'missed=' + snap.sessionsMissed,
    // ⚠ 2026-11-12：`missed` 是**累计值、只增不减**（唯一归零点在 uninstall）⇒ 用户看到
    //   「没看到录音过程」时无法判断是**刚才那次**还是几天前的陈年残留。
    //   把发生时刻一并暴露在 title（原始读数出口），与 `lastFailAt=` 同体例。
    'lastMissedAt=' + (snap.lastMissedAt ? new Date(snap.lastMissedAt).toISOString() : '-'),
    'probeVia=' + (snap.lastProbeVia || '-'),
    'startClicks=' + snap.startClicks, 'stopClicks=' + snap.stopClicks,
    // ⚠ CHG-090：`stopMissed` 此前**只**在 snapshot 里、用户任何可见面都读不到
    //   ⇒ 与 `stopClicks` 相邻只读暴露（`stopClicks` 成功停 / `stopMissed` 停派发失败，成对可判）。
    //   注意：`abandonReason` 仍在数组**首位** ⇒ 降级原因的可读性未被本改动削弱。
    'stopMissed=' + (snap.stopMissed || 0),
    'feedback=' + snap.feedbackSeen,
    // 2026-10-17（报障 D）：失败发生时刻（原始读数，供排查「是不是陈年旧事」）
    'lastFailAt=' + (snap.lastSessionFailed && snap.lastSessionFailedAt ? new Date(snap.lastSessionFailedAt).toISOString() : '-'),
    // ⚠ VAD-1（2026-10-14 定位批 · 不得静默）：静音判定的内部读数（包括阈值）
    //   必须可被用户读到 —— 就是这一格此前**无法判别**：用户只能看到一句
    //   会误导的「以失败收场」，而真正失效的是「声门从未开过」。
    'vadHeard=' + (snap.vadHeardSpeech ? '1' : '0'), 'vadQuiet=' + snap.vadQuietFrames,
    'vadThr=' + (typeof snap.vadThreshold === 'number' ? snap.vadThreshold.toFixed(4) : '0'),
    'vadFloor=' + (typeof snap.vadNoiseFloor === 'number' ? snap.vadNoiseFloor.toFixed(4) : '0'),
    // ⚠ SW-1：开关真值 + 「因开关关闭而未启动 VAD」的采集次数（开关真的约束了行为的证据）
    'vadOn=' + (snap.vadEnabled === false ? '0' : '1'), 'vadSkipped=' + (snap.vadSkipped || 0),
    // ⚠ R3（2026-11-12 · #15 后续）：4 个「当下可判」读数此前**零消费者**（只存在于 snapshot）——
    //   用户无法从 title 区分「VAD 没启动」vs「在跑但门没开」vs「在跑但电平太低」。
    'vadRms=' + (typeof snap.vadRms === 'number' ? snap.vadRms.toFixed(4) : '0'),
    'vadSnr=' + (typeof snap.vadSnr === 'number' ? snap.vadSnr.toFixed(2) : '0'),
    'vadSpeak=' + (snap.vadSpeaking ? '1' : '0'), 'vadPath=' + (snap.vadPath || '-'),
    // ⚠ R9（2026-11-12 · #15 现场）：missed 态的**分叉判据** ——
    //   calls=0 且 missed>0 ⇒ 包装器从未被调用（安装顺序/引用捕获问题，判定逻辑无从谈起）；
    //   calls>0 且 missed>0 ⇒ 首场挂上了、后续场漏挂（官方复用已缓存流，不再调 getUserMedia）。
    //   两者处置完全不同，必须有此读数才能远程定位。
    'calls=' + (snap.callCount || 0),
  ].filter(function (x) { return !!x; }).join(' | ');
  return React.createElement('div', { className: 'dsh-plg-row' },
    React.createElement('span', { className: cls, role: 'status', title: diagTitle }, t('voiceOfficialDiagTitle') + '：' + text),
  );
}
// CHG-117：清口水词**可见性**组件（不得静默失效 —— 承 `CHG-115` `I-2`）。
//   显示：执行次数 / 发生过清理的次数 / 累计删除处数 / 因开关关闭而跳过次数 / 旧配置清理态。
//   ⚠ 开关**关闭**态必须可见（否则用户无法区分「没口水词」与「功能没跑」）。
function FillerDiag(props) {
  const t = makeT(props);
  const [snap, setSnap] = React.useState(function () {
    return (typeof fillerSnapshot === 'function') ? fillerSnapshot() : null;
  });
  React.useEffect(function () {
    const refresh = function () { setSnap(typeof fillerSnapshot === 'function' ? fillerSnapshot() : null); };
    refresh();
    const offs = [];
    if (typeof subscribeFiller === 'function') offs.push(subscribeFiller(refresh));
    // ⚠ 开关变化也要刷新（否则"关闭"态不会即时可见 ⇒ 静默）
    if (typeof subscribeVoiceConfig === 'function') offs.push(subscribeVoiceConfig(refresh));
    return function () { for (const off of offs) { try { off(); } catch (e) { /* 忽略 */ } } };
  }, []);
  if (!snap) return null;
  // ⚠ 开关真值直接读**单一事实源**（`voiceCfgState`），不从 props 传（避免两处真相）
  const cfgNow = (typeof voiceCfgState !== 'undefined' && voiceCfgState && voiceCfgState.value) ? voiceCfgState.value : {};
  const on = !!(cfgNow.filler && cfgNow.filler.enabled !== false);
  let text;
  if (!on) text = t('voiceRefineSkipped');
  else if (snap.cleaned > 0) text = t('voiceRefineCleaned') + ' ×' + snap.cleaned;
  // ⚠ 2026-10-17（文案 bug · 用户可见「清口水词：清口水词」）：此处的谓语原用 t('voiceRefineEnabled')，
  //   而 voiceRefineEnabled 的中文值就是「清口水词」，与主语 t('voiceRefineSection') 同词 ⇒ 主谓同形。
  //   现改用**专表状态的** voiceRefineIdle（'没有需要清理的'），主语/谓语是两个不同的键。
  // 2026-10-17（文案 bug 「清口水词：清口水词」）根因与修法：
  //   渲染是 t('voiceRefineSection') + '：' + 谓词，而谓词键 voiceRefineEnabled 的中文值
  //   也写成「清口水词」⇒ 主语谓语同一个词。
  //   ⇒ 遵守「只改值、不改键名、不新增键」：把**该键的值**改成一句状态话，形态与键名都不动。
  else text = t('voiceRefineEnabled');
  const title = [
    'runs=' + snap.runs, 'cleaned=' + snap.cleaned, 'removed=' + snap.removedTotal,
    'skipped=' + snap.skipped, 'on=' + (on ? '1' : '0'),
    'lastRemoved=' + (snap.lastRemoved && snap.lastRemoved.length ? snap.lastRemoved.map(function (x) { return x.text + '×' + x.count + '(' + x.kind + ')'; }).join(',') : '-'),
    // ⚠ 旧配置一次性清理的可见读数（用户裁定 2：不得静默删）
    'legacyRefine=' + (snap.legacyCleaned ? 'cleaned' : (snap.legacyChecked ? 'none' : 'pending')),
    // 2026-10-17：正常态不再单独显示它，但该事实仍在此可读（键保留、有消费者、信息不丢）
    (snap.legacyChecked && !snap.legacyCleaned ? t('voiceRefineLegacyNone') : ''),
  ].join(' | ');
  return React.createElement('div', { className: 'dsh-plg-row' },
    React.createElement('span', { className: 'dsh-plg-note', role: 'status', title: title },
      t('voiceRefineSection') + '：' + text),
    // 2026-10-17（§7.4 ③「无事发生」类）：**正常态不再报**。原实现对 `legacyChecked && !legacyCleaned`
    //   也渲染一行「无旧版规整配置」—— 那是「无事发生」的复述（用户点名的冗余）。
    //   ⚠ 但**未检完**（pending，即可能还有待处理）仍必须报；清理成功也报（那是有效读数的另一半）。
    //   ⛔ 不得把 pending 也静默掉 —— 那才是「静默失效」。
    React.createElement('span', { className: 'dsh-plg-muted', title: title },
      (snap.legacyCleaned ? ' · ' + t('voiceRefineLegacy') : (snap.legacyChecked ? '' : ' · ' + t('voiceRefineLegacyPending')))),
  );
}

// CHG-143：语音纠错的可见性诊断（不得静默失效 —— 承 CHG-115 I-2）。
//   ⚠ 位置纪律（承 SW-1 先例）：**开关关闭态**分行呈现，且**先报任何失败**（failed/lastCode）
//     再报「因开关未跑」——否则真实故障会被开关态永久掩蔽。
function CorrectionDiag(props) {
  const t = makeT(props);
  const [snap, setSnap] = React.useState(function () {
    return (typeof correctionSnapshot === 'function') ? correctionSnapshot() : null;
  });
  React.useEffect(function () {
    const refresh = function () { setSnap(typeof correctionSnapshot === 'function' ? correctionSnapshot() : null); };
    refresh();
    const offs = [];
    if (typeof subscribeCorrection === 'function') offs.push(subscribeCorrection(refresh));
    // ⚠ 开关变化也要刷新（否则「关闭」态不会即时可见 ⇒ 静默）
    if (typeof subscribeVoiceConfig === 'function') offs.push(subscribeVoiceConfig(refresh));
    return function () { for (const off of offs) { try { off(); } catch (e) { /* 忽略 */ } } };
  }, []);
  if (!snap) return null;
  // ⚠ 开关真值直接读**单一事实源**（voiceCfgState），不从 props 传（避免两处真相）
  const cfgNow = (typeof voiceCfgState !== 'undefined' && voiceCfgState && voiceCfgState.value) ? voiceCfgState.value : {};
  const on = !!(cfgNow.correction && cfgNow.correction.enabled === true);
  // ══ 残留①治理批（2026-10-20 · 本批）：可见文案 = **最近一次执行的结局**，⛔ 不再是页面累计计数。
  //   病历（用户口径 · 承 CHG-090 同族）：旧写法 `if (snap.failed > 0)` 读的是 `correctionState.failed`
  //   （**页面生命期累计**，只在刷新/HMR 归零）⇒ 哪怕最近一次是成功、或压根没跑，设置页也永远
  //   自报「纠错失败 ×N」。把「历史」当成「当下」—— 与本仓 `feedbackSeen`（CHG-090）同一类病。
  //
  //   ⚠ **单一事实源**：结局取自 `snap.phase`，而它由 `correction.js` 的 `correctionPhaseOf()`
  //     **唯一**推导（那台状态机已经拥有「刚刚这一次是什么」这个事实）。⛔ 本渲染层**不**按
  //     runs/failed/changed 这些**累计**计数反推「最近一次是什么」（那正是旧缺陷的成因）。
  //   ⚠ **失败不得被吞掉**：最近一次确实是 failed ⇒ 仍报失败（⛔ 不是为了「不报错」而静默真故障）。
  //     历史累计（runs/ok/changed/failed/skipped/lastCode/lastSkip）**原样保留在 title**。
  //   ⚠ **区分仍在**：「因开关没跑」(skipped / off) 与「跑了没改动」(unchanged) 是两组不同键，
  //     ⛔ 不得合并成同形（PROJECT §7.7 / R12 硬要求）。
  //   ⚠ 位置纪律（承 SW-1）：**真实故障与「没跑」排在开关态之前** —— 开关关着也不能掩蔽最近一次失败。
  //   ⚠ 时间可判性（承 CHG-090 与 2026-10-17 设置文案审查批）：失败/跳过给「多久前」，复用本文件既有
  //     时距函数 `ovbSinceLabel`（⛔ 不新造第二套折算）；取不到时刻 ⇒ **退化为不带时距**的写法，
  //     ⛔ 不得渲染出「（前）」这类残句（拼装前先判空，见下）。
  let text;
  const base = (function () {
    const ph = snap.phase;
    if (ph === 'failed') return t('voiceCorrectionFailed');
    if (ph === 'skipped') return t('voiceCorrectionSkipped');
    if (ph === 'running') return t('voiceCorrectionStateRunning');
    if (ph === 'changed') return t('voiceCorrectionChanged');
    if (ph === 'unchanged') return t('voiceCorrectionNoChange');
    // 走到这里 = 本页还没有任何一次执行（idle）：此时「开关关没关」才是用户此刻的疑问。
    if (!on) return t('voiceCorrectionOff');
    return t('voiceCorrectionArmed');
  })();
  // 括号里只放**这一次**的细节（失败码 / 多久前）—— ⛔ 不放任何累计计数（累计在 title）。
  const detail = (function () {
    const parts = [];
    if (snap.phase === 'failed' && snap.lastFailCode) parts.push(String(snap.lastFailCode));
    // 只有「失败 / 跳过」需要时距（这两态才值得问「是不是陈年旧事」）
    if (snap.phase === 'failed' || snap.phase === 'skipped') {
      const ago = ovbSinceLabel(snap.lastAt, t);
      // ⚠ 文案打磨：「刚刚」本身已含时距，再拼「前」会得到「（刚刚前）」这种别扭串
      //   （既有 official 诊断的键是「…（{when}前）」，那里 when 取不到就整段不渲染；
      //    这里同样的**不得出残句**纪律，用「刚刚 ⇒ 不拼前」实现）。
      // PE-32（2026-11-17）：判据改比 i18n 键值（不再比中文字面量）。
      if (ago) parts.push(ago === t('voiceAgoJustNow') ? ago : t('voiceAgoSuffix').replace('{when}', ago));
    }
    return parts.length ? '（' + parts.join(' · ') + '）' : '';
  })();
  text = base + detail;
  // title = **原始读数出口**（累计全部保留；可见文案不再夹带它们）
  const title = [
    'runs=' + snap.runs, 'ok=' + snap.ok, 'changed=' + snap.changed, 'failed=' + snap.failed,
    'skipped=' + snap.skipped, 'on=' + (on ? '1' : '0'),
    'lastCode=' + (snap.lastCode || '-'),
    'lastSkip=' + (snap.lastSkipReason || '-'),
    // 本批新增两格：最近一次结局 + 发生时刻（可见文案已按时距表达，这里留机器可读原件）
    'phase=' + (snap.phase || '-'),
    'lastAt=' + (snap.lastAt ? new Date(snap.lastAt).toISOString() : '-'),
  ].join(' | ');
  return React.createElement('div', { className: 'dsh-plg-row' },
    React.createElement('span', { className: on ? 'dsh-plg-note' : 'dsh-plg-note dsh-plg-upd-outdated', role: 'status', title: title },
      t('voiceCorrectionSection') + '：' + text),
  );
}
/* UD-0055 / UD-0057（学习词典）：归一与上限一律取契约层（lib/voice-config.cjs），
   本模块不自建筛子/合并逻辑。三处取值都写成 typeof 守卫：真实运行时由 app.cjs 注入，
   测试夹具（test/helpers/client-voice-modules.cjs 的 factoryBody）只取工厂内部正文，
   注入名为位置参数、没有 deps 对象，此时回落到契约层的默认值。 */
const _dictDeps = (typeof d !== 'undefined' && d && typeof d === 'object') ? d : {};
const normalizeDictionaryEntries = typeof _dictDeps.normalizeDictionaryEntries === 'function' ? _dictDeps.normalizeDictionaryEntries : null;
const dictionaryMaxEntries = typeof _dictDeps.VOICE_DICTIONARY_MAX_ENTRIES === 'number' ? _dictDeps.VOICE_DICTIONARY_MAX_ENTRIES : 500;
const dictionaryMaxTerm = typeof _dictDeps.VOICE_DICTIONARY_MAX_TERM === 'number' ? _dictDeps.VOICE_DICTIONARY_MAX_TERM : 20;

// ── 学习词典 · 双集合编辑器（2026-11-13 · 用户点名改造）───────────────
// 口径（用户逐字）：「不要当前这种每一个词典点击启动关闭的，要那种双集合的，一个集合是使用的一个集合是关闭的」。
//   · 词条状态不再由每行一个启停按钮表达 ⇒ 改为「它在哪个集合里」这一个事实；
//     ⊘ 移出（写 enabled=false）/ ↩ 移回（写 enabled=true）。
//   · 数据层零新增：真相仍只有 entries[i].enabled（true=使用中 / false=已停用）
//     —— 不得另立第二个字段表达同一件事（同族缺陷 M-2/M-3）。
//   · 存量配置零迁移：老词条按 enabled 自动落到对应集合（含历史「误关」词条 ⇒ 落在已停用栏，一眼可见）。
//   · 写入统一走 saveVoiceCfg({ dictionary }) ⇒ 本地持久化 + config/set 落盘（既有入口，不新造）。
//   · 归一（长度、形近、去重合并、上限淘汰）一律交契约层 —— 本组件只产出「用户想要的结果」。
function DictionaryEditor(props) {
  const t = makeT(props);
  const v = voiceCfgState.value || {};
  const entries = (v.dictionary && Array.isArray(v.dictionary.entries)) ? v.dictionary.entries : [];
  const [buf, setBuf] = React.useState({ from: '', to: '' });
  const commit = (list) => {
    const normalized = normalizeDictionaryEntries ? normalizeDictionaryEntries(list) : list;
    saveVoiceCfg({ dictionary: { entries: normalized } });
  };
  // ⚠⚠ PE-20 修复（2026-11-17 · 全功能审查 medium）：**编辑中间态不得整条丢弃**。
  //   病历：原实现每次 onChange 都走 commit→normalizeDictionaryEntries，而归一里有
  //     `if (!from || !to || from === to) continue;` 与 `if (Math.abs(from.length-to.length) > 2) continue;`
  //     ⇒ 用户清空「改成」框、或输入一个长度差 >2 的目标词时，**该条目当场被丢弃且无提示**
  //     （实测 `[{from:'绘画',to:''}]` → `[]`）。
  //   修法：**输入期只改本地值、不归一**；归一与丢弃判定只在**提交时机**（失焦 / 离开该行）做。
  //     ⚠ 仍保留 normalize 作为最终闸门（防非法值进配置），只是不再逐键触发。
  const [editing, setEditing] = React.useState(null);  // 正在编辑的行号（null = 无）
  const [draft, setDraft] = React.useState(null);      // 编辑期草稿（与 entries 分离，避免被归一吃掉）
  const commitEdit = () => {
    if (editing === null || !draft) { setEditing(null); setDraft(null); return; }
    const next = entries.map((e, k) => (k === editing ? Object.assign({}, e, draft) : e));
    setEditing(null);
    setDraft(null);
    commit(next);
  };
  // ⚠⚠ PE-20 补修之一（2026-11-17 · 本轮体检 F04-1，**blocker 级**）：
  //   **只有文本输入才延迟提交，开关类动作必须立即提交**。
  //   病历：PE-20 首版把 `patchAt` 统一改成「只置草稿、不 commit」，而「移组 ⊘/↩」按钮
  //     也走 `patchAt`（原实现是立即 commit 的）⇒ **点击完全没有反应**（saveVoiceCfg 调用 0 次）。
  //     这是用户每天都会点的按钮，属功能不可用。
  //   修法：拆成两个入口 ——
  //     · `patchDraftAt`：文本输入用，只改草稿（PE-20 的本意：输入中途不归一、不丢条）
  //     · `toggleAt`：移组/启用类动作，**立即 commit**（它们是「一次点击 = 一个决定」）
  // ⚠⚠ PE-20 补修之二（F04-2）：**结构变更必须清掉编辑态**。
  //   病历：`editing` 存的是**行号**，而 `removeAt` 用 filter 删行 ⇒ 后续行索引整体前移 ⇒
  //     失焦提交会把草稿写进**邻行**并覆盖该行（实测 [甲,乙,丙,丁] → 删甲后提交丙的草稿 → [乙,丙,丙X]，丁丢失）。
  //   修法：任何结构变更（删行 / 新增行）前先把编辑态结算或丢弃，杜绝用陈旧索引提交。
  const patchDraftAt = (i, patch) => {
    if (editing === i && draft) { setDraft(Object.assign({}, draft, patch)); return; }
    setEditing(i);
    setDraft(Object.assign({}, entries[i] || {}, patch));
  };
  const discardEdit = () => { setEditing(null); setDraft(null); };
  const toggleAt = (i, patch) => {
    discardEdit();  // F04-2：先结算编辑态，避免索引陈旧
    const next = entries.map((e, k) => (k === i ? Object.assign({}, e, patch) : e));
    commit(next);   // F04-1：立即落配置（不是草稿）
  };
  const removeAt = (i) => { discardEdit(); commit(entries.filter((e, k) => k !== i)); };
  const addOne = () => {
    const from = String(buf.from || '').trim();
    const to = String(buf.to || '').trim();
    if (!from || !to) return;                         // 两侧都要有；不静默造空条目
    discardEdit();  // F04-2：新增行会改变索引，先结算编辑态
    commit(entries.concat([{ from: from, to: to, hits: 0, at: Date.now(), enabled: true }]));
    setBuf({ from: '', to: '' });
  };
  // 词条输入框：宽度由列宽决定（grid 列），不写死像素宽（本仓两次栽在固定像素）。
  const termInput = (value, onChange, aria, onBlur) => React.createElement('input', {
    type: 'text', className: 'dsh-plg-input va-dict-in', maxLength: String(dictionaryMaxTerm), 'aria-label': aria,
    value: value, onChange: (e) => onChange(e.target.value),
    // PE-20（2026-11-17）：失焦即提交（归一在这一刻发生，输入中途不丢条）。
    onBlur: onBlur || undefined,
  });
  const moveBtn = (title, glyph, onClick) => React.createElement('button', {
    type: 'button', className: 'va-mv', title: title, 'aria-label': title, onClick: onClick,
  }, glyph);
  const delBtn = (onClick) => React.createElement('button', {
    type: 'button', className: 'dsh-plg-btn dsh-plg-btn-icononly',
    title: t('voiceDictDelete'), 'aria-label': t('voiceDictDelete'), onClick: onClick,
  }, '✕');
  // 单条词条：识别成 → 改成 · 命中次数 · 移组 · 删除（两集合共用同一行形态）
  const entryRow = (e, i, disabled) => {
    // PE-20（2026-11-17）：编辑期显示草稿值（不归一），失焦时提交并归一。
    const isEditing = editing === i && draft !== null;
    const shown = isEditing ? draft : e;
    return React.createElement('div', {
      className: 'va-item', key: 'dict-' + i + '-' + (disabled ? 'off' : 'on'),
    },
    termInput(shown.from, (x) => patchDraftAt(i, { from: x }), t('voiceDictFrom'), commitEdit),
    React.createElement('span', { className: 'va-arrow', 'aria-hidden': 'true' }, '→'),
    termInput(shown.to, (x) => patchDraftAt(i, { to: x }), t('voiceDictTo'), commitEdit),
    React.createElement('span', { className: 'va-hits', title: t('voiceDictHits') }, String(e.hits || 0)),
    // ⚠ F04-1（2026-11-17）：移组是「一次点击 = 一个决定」⇒ 走 toggleAt **立即落配置**。
    disabled
      ? moveBtn(t('voiceDictMoveIn') + ' · ' + t('voiceDictToggleHint'), '↩', () => toggleAt(i, { enabled: true }))
      : moveBtn(t('voiceDictMoveOut') + ' · ' + t('voiceDictToggleHint'), '⊘', () => toggleAt(i, { enabled: false })),
    delBtn(() => removeAt(i)),
    );
  };
  const activeIdx = [];
  const offIdx = [];
  for (let i = 0; i < entries.length; i += 1) (entries[i].enabled === false ? offIdx : activeIdx).push(i);
  const boxHead = (title, count, hint) => React.createElement('div', { className: 'va-box-h' },
    React.createElement('span', null, title),
    React.createElement('span', { className: 'va-cnt' }, String(count)),
    React.createElement('em', null, hint),
  );
  const activeBox = React.createElement('div', { className: 'va-box' },
    boxHead(t('voiceDictEnable'), activeIdx.length, t('voiceDictInUseHint')),
    activeIdx.length === 0
      ? React.createElement('div', { className: 'va-emp' }, t('voiceDictEmpty'))
      : activeIdx.map((i) => entryRow(entries[i], i, false)),
    // 新增入口就放在「使用中」集合里 —— 新建即生效（不再「先建再启用」两步）
    React.createElement('div', { className: 'va-item va-add' },
      termInput(buf.from, (x) => setBuf({ from: x, to: buf.to }), t('voiceDictFrom')),
      React.createElement('span', { className: 'va-arrow', 'aria-hidden': 'true' }, '→'),
      termInput(buf.to, (x) => setBuf({ from: buf.from, to: x }), t('voiceDictTo')),
      React.createElement('span', { className: 'va-hits' }, ''),
      // 2026-11-15（用户裁定方案 A · 词典新增行对齐）：补一个与「移组」按钮同宽的**占位**。
      //   病历（真机实测）：词条行 6 个子项、新增行 5 个（没有移组）⇒ 两个输入框各宽 15px
      //   （59.8 vs 74.8），上下边框对不上。占位不可见、不可点、不参与焦点（aria-hidden），
      //   ⛔ 不是按钮：不增加可点区域，也不改变任何行为。
      React.createElement('span', { className: 'va-mv-ph', 'aria-hidden': 'true' }),
      React.createElement('button', {
        type: 'button', className: 'dsh-plg-btn dsh-plg-btn-icononly',
        title: t('voiceDictAdd'), 'aria-label': t('voiceDictAdd'),
        disabled: !String(buf.from).trim() || !String(buf.to).trim(), onClick: addOne,
      }, '＋'),
    ),
  );
  const offBox = React.createElement('div', { className: 'va-box va-box-off' },
    boxHead(t('voiceDictDisable'), offIdx.length, t('voiceDictDisabledHint')),
    offIdx.length === 0
      ? React.createElement('div', { className: 'va-emp' }, t('voiceDictEmptyDisabled'))
      : offIdx.map((i) => entryRow(entries[i], i, true)),
  );
  return React.createElement('div', { className: 'va-grp' },
    React.createElement('div', { className: 'va-gh' },
      React.createElement('b', null, t('voiceDictSection')),
      // PE-32（2026-11-17）：条数前缀走 i18n（EN 界面曾泄漏「 条 · 」）。
      // RT-03（2026-11-17）：单数形态走独立键（EN 下 `1 entries` 是错的）。
      React.createElement('span', null, (entries.length > 0
        ? t(entries.length === 1 ? 'voiceDictCountPrefixOne' : 'voiceDictCountPrefix').replace('{n}', String(entries.length))
        : '') + t('voiceDictTipShort')),
    ),
    React.createElement('div', { className: 'va-dict2' }, activeBox, offBox),
    // 完整说明（原 voiceDictTip 的既有消费者，不得因改版变孤儿）
    React.createElement('div', { className: 'va-hint va-dict-tip' }, t('voiceDictTip') + ' ' + t('voiceDictSkip').replace('{n}', String(dictionaryMaxTerm))),
    entries.length >= dictionaryMaxEntries
      ? React.createElement('div', { className: 'va-hint' }, t('voiceDictFull').replace('{n}', String(dictionaryMaxEntries)))
      : null,
  );
}

function VoiceSection(props) {
  const t = makeT(props);
  const [ver, setVer] = React.useState(0);
  const [status, setStatus] = React.useState(null); // {speech, refine} 就绪态
  // 快捷键录制模式（true=正在等待按键；期间暂停 mic 快捷键监听，避免抢走录制按键）
  const [hotkeyCapture, setHotkeyCapture] = React.useState(false);
  // ⚠⚠ PE-31 修复（2026-11-17 · 全功能审查 medium）：**Esc 必须真的退出捕获态**。
  //   病历（两条，同源）：
  //     ① Esc 分支只清 state 与全局位，**不清焦点** ⇒ 输入框仍在 focus、keydown 仍走本 handler
  //        ⇒ 实测「Esc 之后再按 KeyA」照样写入 combo（用户以为取消了，实际还在录）。
  //     ② 唯一的复位路径是 `onBlur`，而折叠设置段 / 切 tab 时 React **不派发 blur**
  //        （节点直接卸载）⇒ `window.__voiceHotkeyCapturing` 永久为 true ⇒ **热键彻底失效且无提示**。
  //   修法：① Esc / 选完键后显式 `blur()` 输入框；② 卸载时在 useEffect 清理里复位全局位。
  const hotkeyInputRef = React.useRef(null);
  const startHotkeyCapture = () => { if (typeof window !== 'undefined') window.__voiceHotkeyCapturing = true; setHotkeyCapture(true); };
  const cancelHotkeyCapture = () => {
    if (typeof window !== 'undefined') window.__voiceHotkeyCapturing = false;
    setHotkeyCapture(false);
    // ① 必须一并移走焦点：否则后续按键仍由本 handler 接（实测 Esc 后按 KeyA 仍写入 combo）
    try {
      const el = hotkeyInputRef.current;
      if (el && typeof el.blur === 'function') el.blur();
    } catch (e) { /* 组件已卸载 */ }
  };
  // ② 卸载兜底：折叠 / 切 tab 时 React 不派发 blur，必须在这里复位全局位（否则热键永久失效）
  React.useEffect(function () {
    return function () {
      if (typeof window !== 'undefined') window.__voiceHotkeyCapturing = false;
    };
  }, []);
  const onHotkeyKeyDown = (e) => {
    e.preventDefault(); e.stopPropagation();
    if (e.key === 'Escape') { cancelHotkeyCapture(); return; }
    const mods = ['Control', 'Alt', 'Shift', 'Meta'];
    if (mods.indexOf(e.code) >= 0) return; // 纯修饰键按下：等待主键
    const parts = [];
    if (e.ctrlKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    if (e.metaKey) parts.push('Meta');
    parts.push(e.code);
    saveVoiceCfg({ hotkey: { enabled: true, combo: parts.join('+') } });
    cancelHotkeyCapture();
  };
  const clearHotkey = () => { saveVoiceCfg({ hotkey: { enabled: false, combo: '' } }); };

  React.useEffect(() => subscribeVoiceConfig(() => setVer((v) => v + 1)), []);
  // 设置一变即刷新状态（防抖 350ms 合并连续改动；首次跳过）
  const skipFirstVerRef = React.useRef(true);
  React.useEffect(() => {
    if (skipFirstVerRef.current) { skipFirstVerRef.current = false; return; }
    const tmr = setTimeout(() => { check(); }, 350);
    return () => clearTimeout(tmr);
  }, [ver]);
  React.useEffect(() => {
    syncVoiceFromHost();
    check();
  }, []);

  const v = voiceCfgState.value;

  // 就绪态：识别引擎（委托官方 speechToText.snapshot()）+ 规整
  const check = () => {
    host.call(rpcMethods.VOICE_STATUS, {}).then((r) => { setStatus(r && r.ok === true ? r : null); }).catch(() => { setStatus(null); });
  };
  const speechReady = !!(status && status.speech && status.speech.available);
  const speechProviders = (status && status.speech && Array.isArray(status.speech.providers)) ? status.speech.providers : [];

  // CHG-117：原「规整跟随基座模型」的 models/list 拉取与 provider/model 选择面**整体删除**
  //   （清口水词为纯本地规则，无模型可配）。

  // ── 本段依赖的派生值与局部状态（2026-11-13 排版批：声明集中在此之前，控件区只做装配）──
  // 纠错参考轮数归一（0–5，0 = 无参考）：与 host / client 白名单同源，优先取装配层注入的契约实现。
  //   ⚠ 用 typeof 守卫读 d：factoryBody() 会切掉依赖声明块，测试沙箱里 d 未定义 ⇒ 回落同值实现。
  const _cfgDeps = (typeof d !== 'undefined' && d && typeof d === 'object') ? d : {};
  const normalizeCorrectionWindowRounds = typeof _cfgDeps.normalizeCorrectionWindowRounds === 'function'
    ? _cfgDeps.normalizeCorrectionWindowRounds
    : function (n) { return (n === 2 || n === 3) ? n : 1; };

  // 三个开关的真值（单一事实源：voiceCfgState，不从 props 传）
  const fillerCfg = v.filler || {};
  const fillerOn = fillerCfg.enabled !== false;                 // ⚠ 默认开（用户裁定 4）
  const correctionOn = !!(v.correction && v.correction.enabled === true);   // CHG-143：默认关
  // R7（2026-11-12 · #15 后续）：缺省语义与消费端对齐 —— 缺 vad 段视为开（与 ovbVadEnabled 同形）
  const vadOn = !(v.vad && v.vad.enabled === false);
  const silenceSec = Math.round(vadSilenceMsOf(v) / 1000);
  // 2026-11-13（用户裁定 · 开关并入下拉后语义收敛）：不再有「关→开回到上次档位」
  //   用户逐字：「当前开关内置在下拉框之后就没有关→开回到上次档位了，因为打开的话也是用户自己选择了」
  //   ⇒ 下拉里不存在「开」这个动作：用户要开启时必须自己选一个档位，那一步就是写入新档位。
  //   因此「选关时保留 silenceMs 供下次恢复」这条纪律自然失效（没有任何路径会用到被保留的值）——
  //   ⛔ 不再为它保留额外读取；vad.enabled 与 silenceMs 仍是两个字段，语义各自独立。
  //   ⚠ 写入时仍带上当前值：saveVoiceCfg 的 patch.vad 会整体替换 vad 对象
  //     ⇒ 不带就会把未列出的字段归一为默认（floorDb/floorMeasuredAt 会一起丢）。
  //     「带上」是为了不丢其它字段，不是为了「记住档位」。

  // ═══════════════════════════════════════════════════════════════════════════
  // 环境噪声绝对下限（2026-11-12 · 用户方案）：采 3 秒环境 → p95 + 5 dB → 写入 vad.floorDb
  // ═══════════════════════════════════════════════════════════════════════════
  // 为什么实测而非预设：同一句「小声说话」在不同设备上 dBFS 差可达 25 dB
  //   （高增益 USB 麦 ≈ -15，笔记本内置麦 ≈ -40）⇒ 预设值必然对一半设备失效。
  // 为什么取 p95 而非均值：测试期间偶发声响（关门/咳嗽）会把均值拉高 ⇒ 下限偏高 ⇒ 兜底失效。
  // 为什么 +5 dB：≈ 音量翻倍，是「明显高于环境」的最小可辨差（用户拍板值）。
  // ⚠ 为什么就地读 voiceCfgState.value.vad.floorDb 而不注入读取器（2026-11-12）：
  //   factoryBody() 用「工厂内第一个 //」当正文起点、把依赖声明块整段切掉后交给测试沙箱按符号名注入
  //   ⇒ 在依赖声明区新加一行注释会把边界上移，令其后的 const 符号 = d.符号 全部重新落入正文，
  //   与工厂形参重名 ⇒ Identifier 已声明（本次真实事故）。就地读配置既避开该陷阱，
  //   也与 official-bridge.cjs 的 floorDb 读取保持同一形态。
  const floorDbNow = (function () {
    const vd = voiceCfgState && voiceCfgState.value && voiceCfgState.value.vad;
    const n = vd && typeof vd.floorDb === 'number' ? vd.floorDb : NaN;
    return Number.isFinite(n) && n >= -100 && n <= 0 ? n : null;
  })();
  const [measuring, setMeasuring] = React.useState(false);
  const [measureMsg, setMeasureMsg] = React.useState('');
  // 2026-11-13（排版批）：环境噪声改为可编辑输入框（用户逐字「输入框可以自定义输入」）。
  //   · 草稿态 floorDraft：输入过程中不写配置（避免每敲一个字符就 config/set）；
  //   · 提交点 = blur / Enter ⇒ 归一（-100..0，0.1 dB）后写入 vad.floorDb（其余字段原样带上）；
  //   · 非法输入 ⇒ 不写配置，草稿回落到当前值（⛔ 不静默写入一个错值）。
  const [floorDraft, setFloorDraft] = React.useState(floorDbNow === null ? '' : String(floorDbNow));
  const commitFloorDraft = () => {
    const raw = String(floorDraft == null ? '' : floorDraft).trim();
    if (raw === '') { setFloorDraft(floorDbNow === null ? '' : String(floorDbNow)); return; }
    const n = Number(raw);
    const ok = Number.isFinite(n) && n >= -100 && n <= 0;
    if (!ok) { setFloorDraft(floorDbNow === null ? '' : String(floorDbNow)); return; }
    const floor = Math.round(n * 10) / 10;
    saveVoiceCfg({ vad: { enabled: vadOn, silenceMs: normalizeVadSilenceMs(curVad().silenceMs), floorDb: floor, floorMeasuredAt: Date.now() } });
    setFloorDraft(String(floor));
  };
  const runFloorMeasure = () => {
    if (measuring) return;
    setMeasuring(true);
    setMeasureMsg(t('voiceFloorMeasuring'));
    // ⚠ 必须用桥的自开麦测量（2026-11-12 真机修复）：
    //   原实现读 officialVoiceBridge.amplitudeNow()，但那条路径只在录音会话进行中才有值
    //   ⇒ 不录音时恒 null ⇒ 一个样本都采不到 ⇒ 永远「采样不足」。测量必须在录音之前做，
    //   所以只能自己开麦（官方 Recording.amplitude() 同理依赖 analyser，只有开麦后才存在）。
    const bridge = officialVoiceBridge;
    if (!bridge || typeof bridge.measureAmbient !== 'function') {
      setMeasuring(false);
      setMeasureMsg(t('voiceFloorNoBridge'));
      return;
    }
    const finishWith = (samples) => {
      setMeasuring(false);
      if (!samples || samples.length < 5) { setMeasureMsg(t('voiceFloorTooFew')); return; }
      const sorted = samples.slice().sort(function (a, b) { return a - b; });
      // p95 = 环境电平的「上沿」（偶发声响不把下限拉高——用均值/最大值都会偏高）。
      const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
      const db = 20 * Math.log10(Math.max(p95, 1e-9));
      const floor = Math.max(-100, Math.min(0, Math.round((db + 5) * 10) / 10));
      saveVoiceCfg({ vad: { enabled: vadOn, silenceMs: normalizeVadSilenceMs(curVad().silenceMs), floorDb: floor, floorMeasuredAt: Date.now() } });
      setFloorDraft(String(floor));
      setMeasureMsg(t('voiceFloorDone').replace('{db}', String(floor)));
    };
    Promise.resolve(bridge.measureAmbient(3000)).then(function (res) {
      if (res && res.ok === true) { finishWith(res.samples); return; }
      setMeasuring(false);
      // ⚠ 失败原因必须分开可见：一律显示「采样不足」会把「没给麦克风权限」
      //   误导成「环境太安静」——正是本项目反复出现的「读数说反话」同族缺陷。
      const reason = (res && res.reason) || 'unexpected';
      if (reason === 'permission') setMeasureMsg(t('voiceFloorNoPermission'));
      else if (reason === 'device-missing') setMeasureMsg(t('voiceFloorNoDevice'));
      else if (reason === 'no-media-devices' || reason === 'no-audio-context') setMeasureMsg(t('voiceFloorUnsupported'));
      else setMeasureMsg(t('voiceFloorFailed'));
    }).catch(function () {
      setMeasuring(false);
      setMeasureMsg(t('voiceFloorFailed'));
    });
  };

  // 尾部图标按钮（热键清除 / 噪声测试 共用同一形态）
  //   ⚠ 不得变成不可发现：title 与 aria-label 都取自既有文案键。
  //   2026-11-14（内嵌按钮批 · 用户裁定「方案 1」）：按钮从**框外**改为**框内右端**，
  //     与下拉框右侧箭头同一视觉语言（右端对齐 · 垂直居中 · 22×22 · 无边框）。
  //     用户原话：「两个按钮我想内置在下拉框最右侧，就是想要保持和其他下拉框的样式统一」。
  const iconBtn = (title, glyph, onClick, disabled) => React.createElement('button', {
    type: 'button', className: 'va-unit-btn',
    title: title, 'aria-label': title, disabled: !!disabled, onClick: onClick,
  }, glyph);

  // 输入框 + 内嵌尾部按钮（热键 / 噪声两行共用 ⇒ 结构必然同构）
  //   结构：.va-unit > input.va-inp + [.va-suffix 单位] + button.va-unit-btn
  //   ⚠ 单位与按钮都绝对定位在输入框右端：按钮 right:6px，单位 right:34px（按钮左侧）。
  //     dBFS **不跟随数值**（用户终裁：按方案 1 原样，右对齐常驻可见）。
  //   ⚠ suffix 存在时给容器加 .va-has-suffix ⇒ CSS 把输入框右内边距再加宽（避免文字压到单位）。
  const unitField = (inputProps, suffix, actionBtn) => React.createElement('span', {
    className: 'va-unit' + (suffix ? ' va-has-suffix' : ''),
  },
    React.createElement('input', Object.assign({ type: 'text', className: 'dsh-plg-input va-inp' }, inputProps)),
    suffix ? React.createElement('span', { className: 'va-suffix', 'aria-hidden': 'true' }, suffix) : null,
    actionBtn,
  );
  // ═══════════════════════════════════════════════════════════════════════════
  // 2026-11-13（设置面板排版批 · 用户点名方案 H）：开关并入下拉
  //
  // 用户逐字口径：①「有下拉框的，开关集成在下拉框内，倾向面板元素集中一点的排版」
  //              ②「下拉框内容开·跟随全局，这种只需要显示跟随全局就可以了，有档位就是开启状态不需要多余标一个开」
  //              ③「环境噪声的样式和语音热键的样式完全对齐一致，就是输入框可以自定义输入，后面一个小符号代表测试」
  //
  // ⚠ 单一事实源不变（本批最重要的性质）：下拉只是同一份配置的另一种表达 ——
  //   autoEnhance / correction.enabled / filler.enabled / vad.enabled 一个都没改；
  //   选「关」= 把该开关置 false（且保留原档位，与既有「关一下再开回到上次档位」纪律一致）。
  //   ⛔ 不得引入「档位字段即开关」的第二份真相（同族缺陷 M-2/M-3）。
  // ═══════════════════════════════════════════════════════════════════════════

  // 档位下拉的统一形态：关 在首位，其余值 = 开启态 + 该档位。
  //   ⚠ 值文本不带「开 · 」前缀（用户逐字要求）—— 有档位本身就是开启。
  const modeSelect = (id, label, title, value, onChange, options) => React.createElement('select', {
    id: id, className: 'dsh-plg-select', title: title, 'aria-label': label,
    value: value, onChange: (e) => onChange(e.target.value),
  }, options.map((o) => React.createElement('option', { key: o.value, value: o.value }, o.text)));

  const OFF_TEXT = t('voiceSwitchOff');

  // ① 自动增强：关 / 跟随全局 / 五模式（档位 = autoEnhanceMode，空串 = 跟随全局）
  const autoEnhanceModeNow = typeof v.autoEnhanceMode === 'string' ? v.autoEnhanceMode : '';
  const autoEnhanceOptions = [{ value: 'off', text: OFF_TEXT }, { value: '', text: t('voiceAutoEnhanceModeFollow') }]
    .concat(ENHANCE_MODE_VALUES.map((m) => ({ value: m, text: t('modeLabel' + (m.charAt(0).toUpperCase() + m.slice(1))) })));

  // ② 语音纠错：**7 档** = 关 / 无参考 / 1–5 轮会话（档位 = correction.windowRounds，0–5）
  //   ⚠ 2026-11-17（用户需求 · 扩档）：原为 4 档（关 / 1–3 轮）。新增「无参考」= windowRounds 0，
  //     语义是「纠错照跑，但不喂会话历史」（correction.md 已支持 history 为空）。
  const windowRoundsNow = (v.correction && Number.isInteger(v.correction.windowRounds)) ? v.correction.windowRounds : 1;
  const CORRECTION_WINDOW_MAX = 5;
  const correctionOptions = [{ value: 'off', text: OFF_TEXT }, { value: 'none', text: t('voiceCorrectionWindowNone') }]
    .concat(Array.from({ length: CORRECTION_WINDOW_MAX }, function (_, k) {
      const n = k + 1;
      return { value: String(n), text: t('voiceCorrectionWindowRounds').replace('{n}', String(n)) };
    }));

  // ③ 清口水词：关 / 开（无档位，纯布尔）
  const fillerOptions = [{ value: 'off', text: OFF_TEXT }, { value: 'on', text: t('voiceAutoEnhanceOn') }];

  // ④ 静音监测：关 / 1–5 秒（原滑块 ⇒ 档位下拉；真相仍是 vad.enabled + silenceMs）
  const vadOptions = [{ value: 'off', text: OFF_TEXT }]
    .concat([1, 2, 3, 4, 5].map((n) => ({ value: String(n), text: n + ' ' + t('voiceVadSilenceUnit') })));

  // 值→写入（2026-11-13 · 用户裁定后的收敛语义）：
  //   · 选「关」⇒ 只置 enabled=false；那一步没有「档位」这回事，同段其它字段原样带上（不丢值）。
  //   · 选档位 ⇒ enabled=true + 写入该档位（这一步就是「开启」，用户自己挑的）。
  //   ⚠ 每个处理器都在**提交时**现读 voiceCfgState（不从渲染时闭包取值）：
  //     下拉的 onchange 可能晚于一次重新渲染到达，读旧快照会把期间用户改过的同段字段覆盖回旧值。
  const curVad = () => (voiceCfgState && voiceCfgState.value && voiceCfgState.value.vad) || {};
  const onAutoEnhancePick = (raw) => {
    if (raw === 'off') { saveVoiceCfg({ autoEnhance: false }); return; }
    saveVoiceCfg({ autoEnhance: true, autoEnhanceMode: raw });
  };
  const onCorrectionPick = (raw) => {
    if (raw === 'off') { saveVoiceCfg({ correction: { enabled: false, windowRounds: windowRoundsNow } }); return; }
    // 「无参考」也是**开启**纠错（只是不读历史）⇒ enabled:true + windowRounds:0
    if (raw === 'none') { saveVoiceCfg({ correction: { enabled: true, windowRounds: 0 } }); return; }
    saveVoiceCfg({ correction: { enabled: true, windowRounds: normalizeCorrectionWindowRounds(Number(raw)) } });
  };
  const onFillerPick = (raw) => { saveVoiceCfg({ filler: { enabled: raw !== 'off' } }); };
  const onVadPick = (raw) => {
    const vd = curVad();
    // 关：只动 enabled；其余字段（silenceMs/floorDb/floorMeasuredAt）原样带上 ⇒ 一个都不丢
    if (raw === 'off') {
      saveVoiceCfg({ vad: { enabled: false, silenceMs: normalizeVadSilenceMs(vd.silenceMs), floorDb: vd.floorDb, floorMeasuredAt: vd.floorMeasuredAt } });
      return;
    }
    saveVoiceCfg({ vad: { enabled: true, silenceMs: normalizeVadSilenceMs(Number(raw)), floorDb: vd.floorDb, floorMeasuredAt: vd.floorMeasuredAt } });
  };

  // 行定义：标签 + 控件（同一网格里的一个格）
  //   ⚠ 2026-11-14（内嵌按钮批 · 修真实缺陷）：签名原为 (label, control) —— **只接一个控件**。
  //     而热键行/噪声行各传了两个（input + 按钮）⇒ 第二个参数被 JS **静默丢弃** ⇒
  //     按钮从未渲染（headless 实测：.va-ct 宽 219px 全被 input 占满，DOM 里没有 button）。
  //     ⇒ 改为**变长参数**：多于一个就合并渲染（不再有"传了却不见"的静默形态）。
  //     ⚠ GEOLOCK-10 锁住这条：传入 >1 控件时必须全部出现在渲染树里。
  const field = (label, ...controls) => React.createElement('div', { className: 'va-row' },
    React.createElement('span', { className: 'va-lb' }, label),
    React.createElement('div', { className: 'va-ct' }, controls.length === 1 ? controls[0] : controls),
  );

  // 2026-11-11/14（用户两次逐字口径）：环境噪声与语音热键**完全同构** —— 输入框 + 内嵌尾部按钮。
  //   · 热键：只读输入框 + 框内右端 ✕（清除）
  //   · 噪声：可编辑输入框 + 框内右端 ▶（测试）；单位 dBFS 常驻在按钮左侧
  //   ⚠ 两行都走 unitField ⇒ 结构必然同构；宽度由同一网格列决定 ⇒ 严格相等。
  const hotkeyField = field(t('voiceHotkeyCombo'),
    unitField({
      readOnly: true,
      // PE-31（2026-11-17）：ref 供 cancelHotkeyCapture 主动移焦点（Esc 后必须真的退出捕获态）。
      ref: hotkeyInputRef,
      value: hotkeyCapture ? t('voiceHotkeyCapturing') : voiceHotkeyDisplay(v.hotkey.combo),
      placeholder: t('voiceHotkeyNone'),
      title: t('voiceHotkeyCombo') + '\uFF1A' + (hotkeyCapture ? t('voiceHotkeyCapturing') : (voiceHotkeyDisplay(v.hotkey.combo) || t('voiceHotkeyNone'))),
      'aria-label': t('voiceHotkeyCombo'),
      onFocus: startHotkeyCapture, onKeyDown: onHotkeyKeyDown, onBlur: cancelHotkeyCapture,
    }, null, iconBtn(t('voiceHotkeyClear'), '\u2715', clearHotkey)));

  const noiseField = field(t('voiceFloorLabel'),
    unitField({
      inputMode: 'decimal',
      value: floorDraft,
      placeholder: t('voiceFloorUnsetShort'),
      title: t('voiceFloorInputTip'),
      'aria-label': t('voiceFloorLabel'),
      onChange: (e) => setFloorDraft(e.target.value),
      onBlur: commitFloorDraft,
      onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); commitFloorDraft(); } },
    }, 'dBFS', iconBtn(measuring ? t('voiceFloorMeasuring') : t('voiceFloorTest'),
      measuring ? '\u25CC' : '\u25B6', runFloorMeasure, measuring)));
  // ═══════════════════════════════════════════════════════════════════════════
  // 状态区（2026-11-13 · 用户认领的一行摘要 + 诊断按钮）
  //
  // 病历：四条诊断各占一整行（就绪/官方路径/清口水词/语音纠错）⇒ 设置段落纵向冗长、
  //   读起来像四段互不相干的状态。现改为：**一行摘要 + 右侧「诊断」按钮**，详情收进展开区。
  // ⚠ 不得静默失效（本项目硬纪律）：折叠只是视觉收纳 —— 展开区里**原样保留**
  //   就绪态（含 title 原始读数）与三条诊断组件；判定逻辑、文案键、位置纪律一字未改。
  // ⚠ 默认**收起**（用户认领项）；展开/收起各给 aria-expanded，键盘可达。
  // ═══════════════════════════════════════════════════════════════════════════
  const [diagOpen, setDiagOpen] = React.useState(false);
  // 摘要文本 = **当前生效的几项**（就绪态已由左侧 ✓/✗ 表达，⛔ 不再重复拼一遍）
  //   ⚠ 只挑有内容可报的几条；全部关闭 ⇒ 空串（那本身也是有效信息，由左侧状态词承担）
  const summaryGist = (function () {
    const parts = [];
    // PE-32（2026-11-17）：后缀走 i18n（EN 界面曾泄漏「已开启」）。
    // ⚠ RT-03（2026-11-17 第二轮体检）：**不得把「名字」与「状态后缀」直接相加**——
    //   ZH 下「清口水词」+「已开启」恰好可拼；EN 下就是 `Filler` + `on` = **Filleron**（实测）。
    //   改用整句式模板键（名字作为 {name} 代入），中英各自决定分隔与语序。
    if (fillerOn) parts.push(t('voiceStateOnTemplate').replace('{name}', t('voiceRefineShort')));
    if (correctionOn) parts.push(t('voiceStateOnTemplate').replace('{name}', t('voiceCorrectionShort')));
    if (vadOn) parts.push(t('voiceVadShort') + ' ' + silenceSec + ' ' + t('voiceVadSilenceUnit'));
    // 三项全关 ⇒ 明说（⛔ 空白会让人以为是没加载）
    if (!parts.length) parts.push(t('voiceAllOff'));
    return parts.join(' · ');
  })();

  const statusLine = React.createElement('div', { className: 'va-sum' },
    React.createElement('span', { className: 'va-dot' + (speechReady ? '' : ' va-dot-bad'), 'aria-hidden': 'true' }),
    React.createElement('b', { className: speechReady ? 'va-ok' : 'va-bad' },
      speechReady ? '✓ ' + t('voiceStatusReady') : '✗ ' + t('voiceStatusNotReady')),
    React.createElement('span', { className: 'va-txt', title: summaryGist }, summaryGist),
    React.createElement('button', {
      type: 'button', className: 'va-more', 'aria-expanded': diagOpen ? 'true' : 'false',
      onClick: () => setDiagOpen(!diagOpen),
    }, diagOpen ? t('voiceDiagHide') : t('voiceDiagShow')),
  );

  const diagPanel = diagOpen ? React.createElement('div', { className: 'va-diag' },
    // ① 就绪态（title 承载 providers 原始读数 —— 本批未改）
    React.createElement('div', { className: 'dsh-plg-row' },
      React.createElement('span', { className: 'dsh-plg-status',
        title: speechReady ? ('providers=' + speechProviders.length + ' | fillerConfigured=' + !!(status && status.filler && status.filler.configured)) : '' },
        speechReady ? '✓ ' + t('voiceStatusReady') : '✗ ' + t('voiceStatusNotReady')),
    ),
    // ② 官方路径增值对齐的可观测态（不得静默失效）
    React.createElement(OfficialVoiceDiag, props),
    // ③ 清口水词的可见性读数（不得静默失效）
    React.createElement(FillerDiag, props),
    // ④ 语音纠错的可见性读数（不得静默失效）
    React.createElement(CorrectionDiag, props),
  ) : null;

  // 主面板：两列网格（列数由 CSS 定义：恒两栏；⛔ 不做单列切换 —— 用户 2026-11-13 明确叫停）
  const controlsGrid = React.createElement('div', { className: 'va-grid2' },
    // ① 自动增强 —— 关 / 跟随全局 / 五模式
    field(t('voiceAutoEnhance'),
      modeSelect('dsh-vi-auto-enhance', t('voiceAutoEnhance'), t('voiceAutoEnhanceTip'),
        v.autoEnhance ? autoEnhanceModeNow : 'off', onAutoEnhancePick, autoEnhanceOptions)),
    // ② 语音纠错 —— 关 / 参考 N 轮
    field(t('voiceCorrectionShort'),
      modeSelect('dsh-vi-correction', t('voiceCorrectionShort'), t('voiceCorrectionTip'),
        correctionOn ? (windowRoundsNow === 0 ? 'none' : String(windowRoundsNow)) : 'off', onCorrectionPick, correctionOptions)),
    // ③ 清口水词 —— 关 / 开
    field(t('voiceRefineShort'),
      modeSelect('dsh-vi-filler', t('voiceRefineShort'), t('voiceRefineFillerTip'),
        fillerOn ? 'on' : 'off', onFillerPick, fillerOptions)),
    // ④ 静音监测 —— 关 / 1–5 秒
    field(t('voiceVadShort'),
      modeSelect('dsh-vi-vad', t('voiceVadShort'), t('voiceVadSilenceHint'),
        vadOn ? String(silenceSec) : 'off', onVadPick, vadOptions)),
    // ⑤ 语音热键 / ⑥ 环境噪声 —— 完全同构（输入框 + 尾部图标按钮）
    hotkeyField,
    noiseField,
  );

  const body = React.createElement('div', { className: 'dsh-vi-section' },
    statusLine,
    diagPanel,
    controlsGrid,
    // 学习词典（双集合：使用中 / 已停用）
    React.createElement(DictionaryEditor, props),
  );
  return React.createElement(CollapsibleSection, { title: t('voiceSectionTitle') }, body);
}


  return { ovbSinceLabel, OfficialVoiceDiag, FillerDiag, CorrectionDiag, VoiceSection };
}

module.exports = { createVoiceSection };
