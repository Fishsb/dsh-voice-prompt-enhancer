'use strict';
// P2-3（2026-10-13 拆分批）：**RPC 网关与 HTTP 栅栏域** —— 原 `lib/index.cjs` D2 段整体移入。
// 职责：本插件 RPC 路由的传输面——来源栅栏（同源/跨站）、请求体上限、JSON 读写、路由注册。
//
// ⚠ 载体说明：本模块是**真 CommonJS**（非 src/host chunk）。它处理 `request`/`response` 需要
// Node 原生能力，而 `plugin-host.js`（BODY）经 `new Function` 求值、作用域无 require ⇒
// 该域**物理上只能留在 lib/ 侧**（ADR-230 ③）。本批拆分**未触碰载体**（`new Function` 仍在
// `lib/index.cjs`，三选一待用户拍板）。
//
// ⚠ 本文件是**仓库提交物**，不是构建产物（不得由任何 build 脚本生成；`sync-runtime` 的 md5
// 清单经 `lib/*.cjs` 动态枚举自动纳入）。

/** RPC 请求体上限（1MiB）——原实现无上限，本机任意进程 POST 超大 body 可直接吃内存。 */
const RPC_BODY_LIMIT = 1024 * 1024;

/**
 * 2026-09-12（安全修复·审查 H1 实测驱动）：本 RPC 路由注册在 DSH web 鉴权栅栏**之外**——
 * 实测无 token 的 `POST /dsh-voice-prompt-enhancer/rpc`（text/plain，不触发 CORS 预检）返回 200 真实数据，
 * 而 `GET /` 是 401：任意网页可借用户浏览器驱动 config/set、update/portRestart 等副作用。
 * 加来源栅栏：带 Origin 的浏览器请求必须与 Host 同源；Sec-Fetch-Site 为跨站即拒。
 * 无来源头的本机调用（node/curl/插件自身 client 走同源 fetch）不受影响。
 */
// ⚠⚠ PE-09 修复（2026-11-17 · 全功能审查 blocker）：**DNS-rebinding 绕过**。
//   病历：原实现只做 `new URL(origin).host !== headers.host` 的**相等比较**。
//     攻击者控制一个域名，让受害者访问后把该域名解析切到 127.0.0.1（rebinding）——
//     此时浏览器自动填的 Origin 与 Host **都是攻击者域名**，两者相等 ⇒ 原判据通过。
//     实测：`Host=Origin=http://evil.example:3080` + `Sec-Fetch-Site: same-origin` → 200 真实数据。
//   修法（三道，任一道即可挡住 rebinding）：
//     ① **Host 白名单**：Host 头必须是本机回环地址或实际监听端口（rebinding 的 Host 是攻击者域名）；
//     ② Origin 必须同时满足「host 在白名单内」+「与 Host 相等」（原判据保留为第二道）；
//     ③ `Sec-Fetch-Site: cross-site|same-site` 仍拒（原判据保留）。
//   ⚠ 无 Origin 的本机调用（node / curl / 插件自身同源 fetch）不受影响 —— 与既有语义一致。
//   ⚠ 不做 CSRF token：会改变 client 侧契约（需同步改 15 条方法的调用面），超出本批；
//     白名单已把 rebinding 的可行形态挡死，token 作为纵深防御登记为后续项。
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

// 逃生阀：远程访问（LAN / 反向代理 / DSH 远程会话）时 Host 不是回环地址。
// 显式环境变量列出额外可接受的主机名（逗号分隔，小写比较），默认空 = 只认回环。
//   ⚠ 为什么不自动信任「实际监听地址」：该值在本模块拿不到（ctx.get('webServer') 不暴露
//     bind 地址），而自动放宽会把 rebinding 的攻击面重新打开。宁可让远程用户显式配置。
const EXTRA_TRUSTED_HOSTS = new Set(
  String((typeof process !== 'undefined' && process.env && process.env.DSH_PROMPT_ENHANCER_RPC_HOSTS) || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
);

/** Host 头是否为「本机可接受形态」：回环主机名，或纯 IP 且为回环地址。 */
function isTrustedHostHeader(hostHeader) {
  const raw = String(hostHeader || '').trim().toLowerCase();
  if (raw === '') return false;
  // 去端口：支持 `127.0.0.1:3080` / `[::1]:3080` / `localhost:3080`
  let hostname = raw;
  if (raw.startsWith('[')) {
    const close = raw.indexOf(']');
    if (close === -1) return false;
    hostname = raw.slice(0, close + 1);
  } else {
    const colon = raw.lastIndexOf(':');
    if (colon !== -1) hostname = raw.slice(0, colon);
  }
  if (LOOPBACK_HOSTNAMES.has(hostname)) return true;
  if (EXTRA_TRUSTED_HOSTS.has(hostname)) return true;
  // 其余只接受**回环 IP 字面量**（127.0.0.0/8）；任何域名一律拒绝（rebinding 的必经形态）。
  return /^127\.(?:\d{1,3})\.(?:\d{1,3})\.(?:\d{1,3})$/.test(hostname);
}

function isTrustedRpcRequest(request) {
  const headers = (request && request.headers) || {};
  const site = String(headers['sec-fetch-site'] || '').toLowerCase();
  if (site && site !== 'same-origin' && site !== 'none') return false;
  // ① Host 白名单（PE-09 新增的第一道）：rebinding 的 Host 是攻击者域名 ⇒ 在此被拒。
  if (!isTrustedHostHeader(headers.host)) return false;
  const origin = String(headers.origin || '');
  if (origin) {
    try {
      const originHost = new URL(origin).host;
      // ② Origin 自身也必须在白名单内（防 `Origin: http://evil.example` + 伪 Host 的组合）
      if (!isTrustedHostHeader(originHost)) return false;
      // ③ 原判据保留：Origin.host 必须与 Host 相等
      if (originHost !== String(headers.host || '')) return false;
    } catch { return false; }
  }
  return true;
}

function readBody(request) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let aborted = false;
    request.on('data', (chunk) => {
      if (aborted) return;
      size += chunk.length;
      if (size > RPC_BODY_LIMIT) {
        aborted = true;
        chunks.length = 0;
        // ⚠⚠ PE-12 修复（2026-11-17 · 全功能审查 medium）：**不得先 destroy 再写响应**。
        //   病历：原实现 `request.destroy()` 后 resolve(__tooLarge)，handler 随后 writeJson(413)
        //     写向已毁 socket ⇒ 客户端只看到 0 字节 / ECONNRESET，413 契约码**生产不可达**
        //     （单测 RPCG-05 用 `r.destroy = () => {}` 假 req，故判绿 —— 假绿成因见 PE-05）。
        //   修法：**只标记、不销毁**；由 handler 先写出 413 再收尾（见下方 registerRpcRoute）。
        //     不 destroy 也不会吃内存：aborted 后不再 push chunk，后续 data 事件直接 return。
        resolve({ __tooLarge: true });
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (aborted) return;
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        resolve(parsed);
      } catch {
        resolve({});
      }
    });
    request.on('error', () => resolve({}));
  });
}

function writeJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

/**
 * 注册 RPC 路由。依赖全部**显式注入**（模块间只经显式接口，P-M3；不共享全局可变状态）：
 *   deps = { RPC_PATH, handlers:Map, validateRpcArgs }
 * ⚠ 对外签名（`lib/index.cjs` 导出的 `registerRpcRoute(ctx)`）保持**单参**不变 —— 由 index.cjs
 * 做一层薄包装注入 deps，故既有单测 `RPCG-05`（单参调用）**无需改动**。
 */
function registerRpcRoute(ctx, deps) {
  const { RPC_PATH, handlers, validateRpcArgs } = deps;
  const webServer = ctx.get('webServer');
  if (!webServer || typeof webServer.register !== 'function') return;
  webServer.register({
    kind: 'exact',
    path: RPC_PATH,
    handler: async (request, response) => {
      if (request.method !== 'POST') {
        writeJson(response, 405, { ok: false, code: 'METHOD_NOT_ALLOWED' });
        return;
      }
      if (!isTrustedRpcRequest(request)) {
        writeJson(response, 403, { ok: false, code: 'FORBIDDEN_ORIGIN' });
        return;
      }
      const parsedBody = await readBody(request);
      if (parsedBody && parsedBody.__tooLarge === true) {
        // ⚠⚠ PE-12 **补修**（2026-11-17 · 第二轮体检 RT-02，blocker）：
        //   首版是「先 writeJson(413) 再立刻 request.destroy()」——对 curl（无 Accept-Encoding）有效，
        //   但**真实浏览器一律带 `Accept-Encoding: gzip,deflate,br`**，而 DSH web 套了 compression
        //   中间件：`writeJson` 只是把数据交给压缩流，gzip **异步 flush**；此时立刻 destroy 会把
        //   尚未 flush 的压缩流连同 socket 一起毁掉 ⇒ 浏览器看到 0 字节 / `ERR_EMPTY_RESPONSE`
        //   ⇒ **PE-12 要治的「契约码不可达」在浏览器形态下原样成立**（实测：gzip → UND_ERR_SOCKET；
        //   identity → 413 正常；把 destroy 挪到 `finish` 之后 gzip 也能拿到 413）。
        //   修法：**等响应真正写完（`finish`）再销毁入向流**；若客户端已断开/无 finish 事件，靠
        //     `close` 兜底。⛔ 不在 finish 之前 destroy —— 那等于把响应截断。
        writeJson(response, 413, { ok: false, code: 'BODY_TOO_LARGE', message: 'request body exceeds 1MiB' });
        const closeUpstream = () => { try { request.destroy(); } catch (e) { /* 已关闭 */ } };
        if (typeof response.once === 'function') {
          response.once('finish', closeUpstream);
          response.once('close', closeUpstream);
        } else {
          closeUpstream();
        }
        return;
      }
      // ⚠ PE-13 修复（2026-11-17）：body 为 JSON `null` / 数组 / 非对象时，解构会抛到 handler 外
      //   ⇒ 返回 400 **空体**（契约码不可达）。此处先归一成对象，让后续 validateRpcArgs 出码。
      const bodyObj = (parsedBody && typeof parsedBody === 'object' && !Array.isArray(parsedBody)) ? parsedBody : {};
      const { method, args } = bodyObj;
      const check = validateRpcArgs(method, args || {});
      if (!check.ok) {
        writeJson(response, 400, { ok: false, code: check.code, message: check.message });
        return;
      }
      const fn = handlers.get(method);
      if (!fn) {
        writeJson(response, 404, { ok: false, code: 'UNKNOWN_METHOD', method });
        return;
      }
      try {
        const result = await fn(args || {});
        writeJson(response, 200, result || { ok: true });
      } catch (error) {
        writeJson(response, 500, {
          ok: false,
          code: 'HANDLER_FAILED',
          message: String((error && error.message) || error),
        });
      }
    },
  });
}

// ⚠ `writeJson` 是**模块内私有**辅助（仅本文件的 handler 用）⇒ **不进导出面**：
//   R5 判「导出面无消费者 = 死码」，把它导出会制造一个假死码项（P2-3 首跑实测命中）。
module.exports = { RPC_BODY_LIMIT, isTrustedRpcRequest, readBody, registerRpcRoute };
