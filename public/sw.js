'use strict';

/*
 * 离线续用 Service Worker（全站同源、纯静态资源）。
 *
 * 版本化缓存规则：
 *  - 静态资源按 CACHE_VERSION 整体缓存：install 时必须把 PRECACHE_URLS
 *    全部下载成功，才写入整套缓存并提示「可离线使用」；任一资源失败则
 *    删除本次新建的缓存、安装失败，继续沿用旧版本（首次安装则无缓存可用）。
 *    因此新版下载中断时，旧版整套缓存原封不动，旧页面离线续用不受影响。
 *  - 不调用 clients.claim()：已打开的页面在重载前始终由旧 SW 控制、
 *    使用旧版资源，绝不混用新旧脚本；重载（或新开标签导航）后才落到新版本。
 *  - 旧版缓存既不在 activate 时删除，也不在「第一次新版导航」时删除——
 *    另一标签页可能仍停留在旧版页面（由已 redundant 的旧 SW 控制，甚至
 *    已经断网），删掉旧缓存会让它后续请求离线失败。本 SW 只在确认
 *    「没有任何页面仍依赖旧版」后才清理旧缓存：
 *      · activate、每次新版文档导航、页面上报 / 关闭时都尝试一次清理；
 *      · 清理前向所有打开中的窗口（含不由本 SW 控制的旧版页面）询问
 *        正在运行的版本（version-ping），页面用 offline.js 中的
 *        APP_VERSION 应答（version-pong）；
 *      · 只有所有窗口都应答为当前版本（或根本没有窗口）才删除旧缓存；
 *        应答为旧版本、或超时未应答的旧版页面（旧脚本没有应答逻辑）
 *        都视为仍有依赖，保留旧缓存，下次再试。
 *  - fetch 只对 install 时缓存的那套静态资源走缓存优先，且只读本 SW
 *    自己版本的缓存（caches.match 限定 CACHE_NAME），绝不临时写入其它
 *    响应——缓存里只可能有「整套成功」的资源，新旧页面不可能混用资源。
 *  - 草稿仍保存在页面的 localStorage，SW 不缓存任何用户数据。
 *
 * 升级静态资源后必须把 CACHE_VERSION 加 1（内容变化也会触发浏览器发现
 * 新 SW），同时把 public/offline.js 中的 APP_VERSION 改为同一版本号；
 * 测试 test/offline.test.js 会核对两处版本、清单与页面引用一致。
 */

const CACHE_VERSION = 'v2';
const CACHE_NAME = 'json-three-way-merge-static-' + CACHE_VERSION;
const CACHE_PREFIX = 'json-three-way-merge-static-';
const SW_PATH = '/sw.js';

// 离线运行所需的全部静态资源：页面、样式、全部业务脚本、本地打包的 Ajv。
// SW 自身（/sw.js）不在清单内：它按服务器的 no-cache 头每次检查更新。
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/offline.js',
  '/vendor/ajv2020.js',
  '/lib/merge.js',
  '/lib/patch.js',
  '/lib/schema.js',
  '/lib/attribution.js',
  '/lib/suggest.js',
  '/lib/refclosure.js',
  '/lib/delimpact.js',
  '/lib/keyrename.js',
  '/lib/choices.js',
  '/lib/draft.js',
];

const PRECACHE_SET = new Set(PRECACHE_URLS);

// 旧版页面没有应答逻辑：ping 超过该时长未回 pong 即按「仍依赖旧版」处理
const PING_TIMEOUT_MS = 1500;

// 把 fetch 的失败原因整理成中文说明，供页面提示「为什么还不能离线」
function describeFailure(failedUrl, err) {
  const urlPath = failedUrl.replace(/^https?:\/\/[^/]+/, '') || failedUrl;
  const reason = err && err.message ? String(err.message) : String(err || '');
  return `资源 ${urlPath} 下载失败（${reason || '网络错误'}）`;
}

// install：原子化预缓存。先用缓存不可见的方式逐个 fetch，
// 全部成功后才一次性写入新 Cache；任一失败即删除半成品缓存并拒绝安装。
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    let cache;
    try {
      cache = await caches.open(CACHE_NAME);
    } catch (err) {
      await notifyPages({
        type: 'precache-error',
        version: CACHE_VERSION,
        isUpdate: Boolean(self.registration.active),
        reason: `无法创建本地缓存：${(err && err.message) || err}`,
      });
      throw err;
    }

    // 先全部下载到内存：任何一个非 OK / 网络错误都中止，绝不留下半套缓存
    const fetched = [];
    for (const url of PRECACHE_URLS) {
      try {
        const resp = await fetch(url, { cache: 'reload' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        // Response 流只能消费一次：clone 一份留给后续 put
        fetched.push([url, resp.clone()]);
      } catch (err) {
        // 下载阶段失败：cache 尚未写入任何条目；保险起见整个删掉。
        // 旧版本缓存是另一个 CACHE_NAME，这里绝不动它，旧版可继续离线。
        await caches.delete(CACHE_NAME).catch(() => {});
        await notifyPages({
          type: 'precache-error',
          version: CACHE_VERSION,
          isUpdate: Boolean(self.registration.active),
          reason: describeFailure(url, err),
        });
        throw err;
      }
    }

    try {
      await Promise.all(fetched.map(([url, resp]) => cache.put(url, resp)));
    } catch (err) {
      await caches.delete(CACHE_NAME).catch(() => {});
      await notifyPages({
        type: 'precache-error',
        version: CACHE_VERSION,
        isUpdate: Boolean(self.registration.active),
        reason: `写入本地缓存失败：${(err && err.message) || err}`,
      });
      throw err;
    }

    // 整套资源已就绪：通知所有打开的页面。更新场景下页面会提示
    // 「新版已就绪，重载后生效」，当前页仍保持旧版直到重载。
    await notifyPages({
      type: 'precache-ok',
      version: CACHE_VERSION,
      isUpdate: Boolean(self.registration.active),
    });

    // 跳过 waiting：下次导航 / 新开标签即由新 SW 接管；不调用 claim，
    // 因此已打开的页面在重载前不会收到新版资源。
    self.skipWaiting();
  })());
});

// activate：不 claim 现有页面，也不删旧缓存——旧版页面在重载前仍由
// 旧 SW 控制，其离线响应还要依赖旧版缓存；只尝试一次「确认无人依赖后」
// 的清理（清理条件不满足就保留，见 sweepStaleCaches）。
self.addEventListener('activate', (event) => {
  // 尽力而为：条件不满足（仍有旧版页面）就保留旧缓存，导航 / 页面通知会再试
  event.waitUntil(sweepStaleCaches().catch(() => {}));
});

// 确认没有任何打开中的页面仍依赖旧版后，才删除其它版本的缓存。
// 判定方式：向所有窗口（包括不由本 SW 控制的旧版页面）询问运行版本，
// 全部应答为当前版本（或无窗口）才可清理；旧版本应答 / 超时未应答 /
// 查询出错都保留旧缓存，等待下次触发。
let sweeping = false;

async function sweepStaleCaches() {
  if (sweeping) return;
  sweeping = true;
  try {
    let clients;
    try {
      clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
    } catch {
      return; // 查询不到页面状态时保守保留旧缓存
    }

    const versions = await Promise.all(clients.map(pingClientVersion));
    // 任何一个窗口仍在旧版（或无法确认版本），旧缓存就继续保留
    if (versions.some((v) => v !== CACHE_VERSION)) return;

    const names = await caches.keys();
    await Promise.all(names
      .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map((name) => caches.delete(name)));
  } catch {
    // 清理失败不影响响应；下次导航 / 页面上报会再试
  } finally {
    sweeping = false;
  }
}

// 询问单个窗口正在运行的资源版本。新版页面（offline.js）应答
// APP_VERSION；旧版页面无应答逻辑，超时后返回 null —— 一律视为旧版。
function pingClientVersion(client) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(null);
    }, PING_TIMEOUT_MS);
    const messageChannel = new MessageChannel();
    messageChannel.port1.onmessage = (event) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const data = (event && event.data) || {};
      resolve(data.type === 'version-pong' && typeof data.version === 'string'
        ? data.version
        : null);
      try { messageChannel.port1.close(); } catch { /* 忽略 */ }
    };
    try {
      client.postMessage({ type: 'version-ping' }, [messageChannel.port2]);
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

// fetch：仅处理同源 GET 且属于整套清单的静态资源，缓存优先；
// 且只读本 SW 自己版本的缓存，绝不运行时写入任何内容
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  let key = url.pathname;
  if (key === '/index.html') key = '/';
  // SW 自身永不命中缓存：保证每次都能检查到新版本
  if (url.pathname === SW_PATH) return;
  if (!PRECACHE_SET.has(key) && !PRECACHE_SET.has(url.pathname)) return;

  event.respondWith((async () => {
    // 只可能命中本 SW 版本（与 install 写入的是同一套资源）的缓存
    const cached = await caches.match(req, { ignoreSearch: false, cacheName: CACHE_NAME });
    if (cached) {
      // 新版文档导航完成后再尝试清理：此刻加载的必然是同版 HTML + 同版
      // 资源；但其它标签页可能仍在旧版，清理仍以「全部窗口版本确认」为准
      if (req.mode === 'navigate') sweepStaleCaches();
      return cached;
    }
    // 缓存尚未就绪（理论上不会发生：未成功安装的 SW 不会接管页面）：
    // 直接走网络，且不写入缓存
    const resp = await fetch(req);
    if (req.mode === 'navigate') sweepStaleCaches();
    return resp;
  })());
});

// 页面消息：加载 / 关闭通知（触发清理核对）与缓存完整性状态查询
self.addEventListener('message', (event) => {
  const data = event.data || {};

  // 页面加载完成（client-ready）或关闭 / 跳走（client-closed）后都再试一次：
  // 尤其最后一个旧版页面关闭时，旧缓存由此被及时回收
  if (data.type === 'client-ready' || data.type === 'client-closed') {
    event.waitUntil(sweepStaleCaches().catch(() => {}));
    return;
  }

  if (data.type !== 'offline-status') return;
  event.waitUntil((async () => {
    let ok = false;
    try {
      const cache = await caches.open(CACHE_NAME);
      const keys = await cache.keys();
      const have = new Set(keys.map((r) => new URL(r.url).pathname));
      // 「/」与「/index.html」指向同一文档，缓存其一即可
      const normalized = new Set(have);
      if (normalized.has('/index.html')) normalized.add('/');
      if (normalized.has('/')) normalized.add('/index.html');
      ok = PRECACHE_URLS.every((u) => normalized.has(u));
    } catch {
      ok = false;
    }
    const port = event.ports && event.ports[0];
    if (port) port.postMessage({ type: 'offline-status-result', version: CACHE_VERSION, ok });
  })());
});

// 给所有已打开的页面发消息（首次安装时页面可能尚未准备好接收，
// 页面侧另有 registration 事件与 offline-status 查询兜底）
async function notifyPages(message) {
  try {
    const clients = await self.clients.matchAll({ includeUncontrolled: true });
    for (const client of clients) client.postMessage(message);
  } catch {
    // 页面收不到不影响缓存本身的正确性
  }
}
