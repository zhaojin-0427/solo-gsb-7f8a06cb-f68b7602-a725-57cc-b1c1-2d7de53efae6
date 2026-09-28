'use strict';

/*
 * 离线续用 Service Worker（全站同源、纯静态资源）。
 *
 * 多标签更新期间的版本绑定与缓存清理规则：
 *  - 静态资源按 CACHE_VERSION 整体缓存：install 时必须把 PRECACHE_URLS
 *    全部下载成功，才写入整套缓存并提示「可离线使用」；任一资源失败则
 *    删除本次新建的缓存、安装失败，继续沿用旧版本（首次安装则无缓存可用）。
 *    下载阶段不提前创建同名缓存，避免更新下载进行中被旧 SW 的清理逻辑误删。
 *  - 安装成功后 skipWaiting()，但绝不调用 clients.claim()：
 *      * 已打开的旧标签在重载前仍由旧（redundant）SW 控制，只使用它安装时
 *        缓存的那一套旧版完整资源；
 *      * 新导航 / 新开标签由本 SW 接管，拿到的必然是完整新版（导航与同版
 *        子资源都只从本版缓存响应）。
 *  - 本 SW 对它实际处理的每个客户端做版本绑定：
 *      * 导航请求在响应前就把 resultingClientId 记为新版；
 *      * 页面加载 / bfcache 恢复时会 postMessage 上报自身 APP_VERSION；
 *      * 激活瞬间仍存活、且无法确认是新版的客户端，一律保守记为旧版。
 *    旧版客户端的子资源只从对应旧版缓存响应，绝不回落到新版缓存，
 *    因此新旧脚本、样式不可能混用；旧缓存里只可能有「整套成功」的资源，
 *    旧标签断网也照常可用。
 *  - 旧版缓存只在「确认没有任何页面依赖旧版」后才删除：每次清理都枚举
 *    当前全部存活客户端，只要还有未确认切到新版的标签（或状态未知的标签），
 *    就保留全部旧缓存；最后一个旧标签重载 / 关闭后的下一次导航或上报，
 *    才真正清理。
 *  - 新版下载中断 / 任一资源失败：半成品缓存不落盘、不 skipWaiting，
 *    旧 SW 与旧版整套缓存原样保留，旧版离线使用不受影响。
 *  - fetch 只对 install 时缓存的那几套静态资源读缓存，绝不临时写入
 *    其它响应。
 *  - 草稿仍保存在页面的 localStorage，SW 不缓存任何用户数据。
 *
 * 升级静态资源后必须把 CACHE_VERSION 加 1，并同步修改 offline.js 顶部的
 * APP_VERSION（test/offline.test.js 会核对两者一致及清单与页面引用一致）。
 */

const CACHE_VERSION = 'v2';
const CACHE_PREFIX = 'json-three-way-merge-static-';
const CACHE_NAME = CACHE_PREFIX + CACHE_VERSION;
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

// 把 fetch 的失败原因整理成中文说明，供页面提示「为什么还不能离线」
function describeFailure(failedUrl, err) {
  const urlPath = failedUrl.replace(/^https?:\/\/[^/]+/, '') || failedUrl;
  const reason = err && err.message ? String(err.message) : String(err || '');
  return `资源 ${urlPath} 下载失败（${reason || '网络错误'}）`;
}

// install：原子化预缓存。先用缓存不可见的方式逐个 fetch（此时完全不创建
// 同名 Cache，杜绝更新下载进行中被旧 SW 的清旧逻辑误删），全部成功后才
// 一次性创建并写入新 Cache；任一失败即拒绝安装，不留任何半成品。
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    // 先全部下载到内存：任何一个非 OK / 网络错误都中止，绝不留下半套缓存
    const fetched = [];
    for (const url of PRECACHE_URLS) {
      try {
        const resp = await fetch(url, { cache: 'reload' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        // Response 流只能消费一次：clone 一份留给后续 put
        fetched.push([url, resp.clone()]);
      } catch (err) {
        // 下载阶段失败：缓存从未创建，无需清理；旧版缓存也完全不受影响
        await notifyPages({
          type: 'precache-error',
          version: CACHE_VERSION,
          isUpdate: Boolean(self.registration.active),
          reason: describeFailure(url, err),
        });
        throw err;
      }
    }

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
    // 因此已打开的旧标签在重载前不会收到新版资源。
    self.skipWaiting();
  })());
});

// ---------- 客户端版本绑定 ----------
//
// newClients       已确认运行当前版本（CACHE_VERSION）的客户端 id
// clientVersions   页面通过 client-ready 消息显式上报的版本（如 bfcache 恢复
//                  的旧标签：没有导航事件，只能靠上报识别）
// legacySnapshot   激活瞬间仍存活、且当时无法确认是新版的客户端——
//                  保守起见全部按旧版对待
// pinnedLegacyCache 激活时存在的最新一套旧缓存，供无法细分版本的旧客户端
//                  （v1 时代的页面不会上报版本）使用
const newClients = new Set();
const clientVersions = new Map();
const legacySnapshot = new Set();
let pinnedLegacyCache;

let activatedResolve;
const activated = new Promise((resolve) => { activatedResolve = resolve; });

function cacheVersionOf(name) {
  return name && name.startsWith(CACHE_PREFIX)
    ? name.slice(CACHE_PREFIX.length)
    : null;
}

function versionRank(version) {
  const n = parseInt(String(version).replace(/^v/i, ''), 10);
  return Number.isFinite(n) ? n : -1;
}

// 现存且比本 SW 更旧的缓存名，按版本从新到旧排列。
// 绝不删除更新版本的缓存：旧 SW（redundant 后仍可能收到旧页面消息）
// 只能清理比自己更老的版本，防止误伤已经装好的新版整套缓存。
async function legacyCacheNames() {
  const currentRank = versionRank(CACHE_VERSION);
  const names = await caches.keys();
  return names
    .filter((name) => {
      const v = cacheVersionOf(name);
      if (v === null || name === CACHE_NAME) return false;
      return versionRank(v) < currentRank;
    })
    .sort((a, b) => versionRank(cacheVersionOf(b)) - versionRank(cacheVersionOf(a)));
}

function pinNavigationClient(event) {
  // 新文档导航：响应发出前就把目标客户端绑定到当前版本。
  // reload / 新开标签产生新的 resultingClientId；极少数环境拿不到时
  // 退回 clientId（不影响正确性，最坏只是该 id 被当作新版）。
  const id = event.resultingClientId || event.clientId;
  if (!id) return;
  newClients.add(id);
  legacySnapshot.delete(id);
}

function noteClientVersion(clientId, version) {
  if (!clientId || !version) return;
  if (version === CACHE_VERSION) {
    newClients.add(clientId);
    legacySnapshot.delete(clientId);
    return;
  }
  // 上报的是其它（旧）版本：记为旧版依赖者，保留其旧缓存
  clientVersions.set(clientId, version);
  legacySnapshot.add(clientId);
}

// 为已确认属于旧版的客户端挑选它应使用的整套缓存：
// 优先精确匹配上报版本，否则用激活时记录的最新旧缓存，再否则用现存最新旧缓存
async function legacyCacheForClient(clientId) {
  const names = await legacyCacheNames();
  if (!names.length) return undefined;
  const reported = clientVersions.get(clientId);
  if (reported) {
    const exact = names.find((name) => cacheVersionOf(name) === reported);
    if (exact) return exact;
  }
  if (pinnedLegacyCache && names.includes(pinnedLegacyCache)) return pinnedLegacyCache;
  return names[0];
}

// activate：不 claim 现有页面。这里只做一次客户端清点——激活瞬间仍存活、
// 又无法确认已是新版的客户端，全部保守记为旧版依赖者；随后尝试清理
// （首次安装时没有任何旧缓存，也没有旧客户端）。
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    const currentRank = versionRank(CACHE_VERSION);
    const legacyNames = names
      .filter((name) => {
        const v = cacheVersionOf(name);
        return v !== null && name !== CACHE_NAME && versionRank(v) < currentRank;
      })
      .sort((a, b) => versionRank(cacheVersionOf(b)) - versionRank(cacheVersionOf(a)));
    pinnedLegacyCache = legacyNames[0];

    const clients = await self.clients.matchAll({ includeUncontrolled: true });
    for (const client of clients) {
      const id = client && client.id;
      if (!id) continue;
      if (newClients.has(id)) continue;
      if (clientVersions.get(id) === CACHE_VERSION) continue;
      legacySnapshot.add(id);
    }

    activatedResolve();
    await sweepStaleCaches();
  })());
});

// 删除旧版缓存的唯一入口：枚举当前全部存活客户端，只要还有一个
// 「未确认切到当前版本」的标签（显式旧版 / 激活时在场 / 状态未知），
// 就保留全部旧缓存；确认无页面依赖旧版后才整体删除。
let sweeping = false;
async function sweepStaleCaches() {
  await activated;
  if (sweeping) return;
  sweeping = true;
  try {
    const clients = await self.clients.matchAll({ includeUncontrolled: true });
    const live = new Set();
    for (const client of clients) {
      if (client && client.id) live.add(client.id);
    }

    let legacyDependents = 0;
    for (const id of live) {
      if (newClients.has(id)) continue;
      if (clientVersions.get(id) === CACHE_VERSION) continue;
      // 显式上报旧版、激活时已在场（旧标签），或任何状态未知的新出现
      // 客户端：一律保守视为仍可能依赖旧版
      legacyDependents += 1;
    }

    // 统计完成后再忘掉已经消失的客户端绑定，避免集合无限增长
    for (const id of [...newClients]) {
      if (!live.has(id)) newClients.delete(id);
    }
    for (const id of [...clientVersions.keys()]) {
      if (!live.has(id)) clientVersions.delete(id);
    }
    for (const id of [...legacySnapshot]) {
      if (!live.has(id)) legacySnapshot.delete(id);
    }

    if (legacyDependents > 0) return;

    const stale = await legacyCacheNames();
    await Promise.all(stale.map((name) => caches.delete(name)));
  } catch {
    // 清理失败不影响响应；下次导航 / 上报会再试
  } finally {
    sweeping = false;
  }
}

// fetch：仅处理同源 GET 且属于整套清单的静态资源。
//  - 导航：一律以当前版本整套缓存响应（并提前绑定 resultingClient），
//    保证新导航拿到的是完整新版；随后尝试清理旧缓存。
//  - 子资源：按客户端绑定的版本，只从它所属的那一整套缓存响应，
//    绝不跨版本回落，从机制上杜绝新旧脚本混用。
// 清单外请求一律直接走网络，SW 不缓存任何其它内容。
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // SW 自身永不命中缓存：保证每次都能检查到新版本
  if (url.pathname === SW_PATH) return;

  const key = url.pathname === '/index.html' ? '/' : url.pathname;
  if (!PRECACHE_SET.has(key) && !PRECACHE_SET.has(url.pathname)) return;

  if (req.mode === 'navigate') pinNavigationClient(event);

  event.respondWith((async () => {
    await activated;

    if (req.mode === 'navigate') {
      // 新导航 / 重载：必然给完整新版
      const fresh = await caches.match(req, { ignoreSearch: false, cacheName: CACHE_NAME });
      const resp = fresh || await fetch(req);
      // 能走到这里说明新版文档正在加载：若旧标签已全部离开，即可清理旧缓存
      sweepStaleCaches();
      return resp;
    }

    const clientId = event.clientId;
    const onNewVersion = !clientId
      || newClients.has(clientId)
      || clientVersions.get(clientId) === CACHE_VERSION;

    if (onNewVersion) {
      const cached = await caches.match(req, { ignoreSearch: false, cacheName: CACHE_NAME });
      if (cached) return cached;
      // 缓存缺失（理论上不会发生：整套成功才接管）：走网络且不写入
      return fetch(req);
    }

    // 旧标签重载前的子资源请求：只允许使用它自己那套旧版完整资源，
    // 绝不从新版缓存取，避免混用；旧缓存缺失时走网络兜底，也不写缓存
    const legacyName = await legacyCacheForClient(clientId);
    if (legacyName) {
      const cached = await caches.match(req, { ignoreSearch: false, cacheName: legacyName });
      if (cached) return cached;
    }
    return fetch(req);
  })());
});

// 消息：
//  - client-ready：页面（含 bfcache 恢复）上报自身资源版本，用于版本绑定
//  - offline-status：查询当前整版缓存是否完整可用
self.addEventListener('message', (event) => {
  const data = event.data || {};

  if (data.type === 'client-ready') {
    const clientId = event.source && event.source.id;
    noteClientVersion(clientId, data.version);
    // 最后一个旧标签重载 / bfcache 恢复为新版可能只产生消息、不产生导航，
    // 因此上报后也尝试一次清理
    if (event.waitUntil) event.waitUntil(sweepStaleCaches());
    else sweepStaleCaches();
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
