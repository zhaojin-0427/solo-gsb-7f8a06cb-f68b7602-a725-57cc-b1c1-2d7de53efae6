'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { server } = require('../server.js');

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const SW_PATH = path.join(PUBLIC_DIR, 'sw.js');
const HTML_PATH = path.join(PUBLIC_DIR, 'index.html');

const html = fs.readFileSync(HTML_PATH, 'utf8');
const swSource = fs.readFileSync(SW_PATH, 'utf8');

// 在隔离沙箱里求值 sw.js 源码，提取常量与事件注册（不执行事件回调）
function loadSwModule() {
  const listeners = {};
  const sandbox = {
    self: {
      skipWaiting() {},
      clients: { matchAll: async () => [] },
      location: { origin: 'http://localhost:8080' },
      addEventListener(type, fn) {
        listeners[type] = listeners[type] || [];
        listeners[type].push(fn);
      },
      registration: { active: null },
    },
    caches: {
      keys: async () => [],
      open: async () => ({ keys: async () => [] }),
      delete: async () => true,
    },
    fetch: async () => new Response(),
    URL,
    Response: class { clone() { return this; } },
    MessageChannel: class {},
    console,
  };
  vm.createContext(sandbox);
  // 顶层 const 不会挂到全局对象上：追加一行把所需常量导出到全局
  vm.runInContext(`${swSource}\n;globalThis.__sw = { CACHE_NAME, CACHE_VERSION, PRECACHE_URLS };`, sandbox, { filename: 'sw.js' });
  return { sandbox, listeners };
}

const { sandbox, listeners } = loadSwModule();
const CACHE_NAME = sandbox.__sw.CACHE_NAME;
const CACHE_VERSION = sandbox.__sw.CACHE_VERSION;
const PRECACHE_URLS = sandbox.__sw.PRECACHE_URLS;

test('sw.js：语法合法（node --check）', () => {
  execFileSync(process.execPath, ['--check', SW_PATH]);
});

test('sw.js：注册了 install / activate / fetch / message 事件', () => {
  for (const type of ['install', 'activate', 'fetch', 'message']) {
    assert.ok(Array.isArray(listeners[type]) && listeners[type].length > 0, `缺少 ${type} 监听`);
  }
});

test('缓存名带版本号', () => {
  assert.match(CACHE_NAME, /^json-three-way-merge-static-v\d+$/);
});

test('预缓存清单覆盖 index.html 引用的全部脚本与样式', () => {
  const referenced = ['/'];
  for (const m of html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)) referenced.push(m[1]);
  for (const m of html.matchAll(/<link[^>]*\shref="([^"]+\.css)"/g)) referenced.push(m[1]);

  const set = new Set(PRECACHE_URLS);
  for (const url of referenced) {
    assert.ok(set.has(url), `预缓存清单缺少页面引用的资源：${url}`);
  }
});

test('预缓存清单：页面、样式、全部业务脚本与本地 Ajv 都在其中', () => {
  const required = [
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
  assert.deepEqual([...PRECACHE_URLS].sort(), [...required].sort());
});

test('预缓存清单中的每个资源在磁盘上都存在', () => {
  for (const url of PRECACHE_URLS) {
    // 文档与业务脚本在 public/；/lib、/vendor 映射到仓库根同名目录
    const inPublic = url === '/' || url === '/index.html'
      || (!url.startsWith('/lib/') && !url.startsWith('/vendor/'));
    const rel = url === '/' ? 'index.html' : url.replace(/^\/+/, '');
    const file = inPublic ? path.join(PUBLIC_DIR, rel) : path.join(ROOT, rel);
    assert.ok(fs.existsSync(file), `清单中的资源不存在：${url}`);
    assert.ok(fs.statSync(file).size > 0, `清单中的资源为空：${url}`);
  }
});

test('sw.js 自身不进预缓存清单（它需要按 no-cache 回源做字节检查）', () => {
  assert.ok(!PRECACHE_URLS.includes('/sw.js'));
});

test('sw.js：不调用 clients.claim（已打开页面重载前保持旧版）', () => {
  // 只检查事件回调代码（避开注释中的说明文字）
  for (const [type, fns] of Object.entries(listeners)) {
    for (const fn of fns) assert.doesNotMatch(fn.toString(), /\.claim\s*\(/, `${type} 回调不应调用 claim`);
  }
});

test('sw.js：仅缓存清单内同源 GET，不做运行时写入（cache.put 只在 install 中）', () => {
  // fetch 回调中不应出现 cache.put / caches.open(...).put 等写入
  const fetchHandler = listeners.fetch[0].toString();
  assert.doesNotMatch(fetchHandler, /\.put\s*\(/);
  assert.match(fetchHandler, /method\s*!==\s*['"]GET['"]/);
  assert.match(fetchHandler, /origin/);
});

test('页面加载了离线注册脚本且它在业务脚本之前', () => {
  assert.match(html, /<script[^>]*\ssrc="\/offline\.js"/);
  const offlineScript = fs.readFileSync(path.join(PUBLIC_DIR, 'offline.js'), 'utf8');
  assert.match(offlineScript, /register\(SW_URL\)/);
  const iOff = html.indexOf('/offline.js');
  const iApp = html.indexOf('/app.js');
  assert.ok(iOff > 0 && iApp > iOff);
});

// ---------- 经真实 HTTP 服务器核对资源可达与缓存策略头 ----------

async function withServer(run) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    await run(port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function get(port, urlPath) {
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`);
  const body = await res.text();
  return { status: res.status, headers: res.headers, body };
}

test('服务器：预缓存清单中的全部资源都可 200 获取', async () => {
  await withServer(async (port) => {
    for (const url of PRECACHE_URLS) {
      const res = await get(port, url === '/' ? '/' : url);
      assert.equal(res.status, 200, `${url} 应返回 200`);
      assert.ok(res.body.length > 0, `${url} 响应体为空`);
    }
  });
});

test('服务器：/sw.js 与 HTML 带 Cache-Control: no-cache，其它资源不强制', async () => {
  await withServer(async (port) => {
    const sw = await get(port, '/sw.js');
    assert.match(sw.headers.get('cache-control') || '', /no-cache/);
    const indexRes = await get(port, '/');
    assert.match(indexRes.headers.get('cache-control') || '', /no-cache/);
    const app = await get(port, '/app.js');
    assert.equal(app.headers.get('content-type'), 'text/javascript; charset=utf-8');
  });
});

test('服务器：sw.js 不在对外静态目录列举之外的路径也正常（404）', async () => {
  await withServer(async (port) => {
    const missing = await get(port, '/not-there.js');
    assert.equal(missing.status, 404);
  });
});

// ---------- install 原子性：整套成功才落缓存，任一失败即回滚 ----------

// 构造可驱动事件回调的 SW 沙箱。fetchImpl(url) 决定每个资源的成败；
// fakeCaches 模拟 CacheStorage 中各命名缓存的内容。
function makeSwSandbox(fetchImpl, initialCaches) {
  const installed = initialCaches || {};
  const messages = [];
  const openedCacheNames = [];
  const api = { listeners: {}, messages, installed, openedCacheNames };

  // 当前「存活」的客户端（对应 self.clients.matchAll 的结果），
  // 各测试可用 setLiveClients 动态调整，模拟标签打开 / 重载 / 关闭
  let liveClients = [{ id: 'page-1', postMessage(m) { messages.push(m); } }];
  api.setLiveClients = (ids) => {
    liveClients = ids.map((id) => ({
      id,
      postMessage(m) { messages.push(m); },
    }));
  };

  class FakeCache {
    constructor(name) { this.name = name; this.items = installed[name] || new Map(); }
    async put(req, resp) {
      const u = typeof req === 'string' ? req : new URL(req.url).pathname;
      this.items.set(u, resp);
      installed[this.name] = this.items;
    }
    async keys() { return [...this.items.keys()].map((u) => ({ url: `http://localhost:8080${u}` })); }
  }

  const sandbox = {
    URL,
    Response: class {
      constructor(ok) { this.ok = ok !== false; }
      clone() { return this; }
    },
    console: { log() {}, warn() {}, error() {} },
    MessageChannel: class {},
    fetch: async (u) => {
      const r = fetchImpl(String(u));
      if (r instanceof Error) throw r;
      return new sandbox.Response(r);
    },
    caches: {
      async open(name) {
        openedCacheNames.push(name);
        return new FakeCache(name);
      },
      async delete(name) { delete installed[name]; return true; },
      async keys() { return Object.keys(installed); },
      // 模拟 caches.match：按 cacheName 选项限定缓存，用 pathname 精确匹配
      async match(req, options) {
        const p = typeof req === 'string' ? new URL(req, 'http://localhost:8080').pathname : new URL(req.url).pathname;
        const names = options && options.cacheName ? [options.cacheName] : Object.keys(installed);
        for (const name of names) {
          const items = installed[name];
          if (items && items.has(p)) return items.get(p);
        }
        return undefined;
      },
    },
  };

  const selfObj = {
    location: { origin: 'http://localhost:8080' },
    listeners: {},
    skipWaitingCalled: 0,
    skipWaiting() { selfObj.skipWaitingCalled++; },
    clients: { matchAll: async () => liveClients.map((c) => ({ id: c.id, postMessage: c.postMessage })) },
    registration: { active: null },
    addEventListener(type, fn) {
      selfObj.listeners[type] = selfObj.listeners[type] || [];
      selfObj.listeners[type].push(fn);
    },
  };
  sandbox.self = selfObj;

  vm.createContext(sandbox);
  vm.runInContext(
    `${swSource}\n;globalThis.__sw = { CACHE_NAME, CACHE_VERSION, PRECACHE_URLS, newClients, clientVersions, legacySnapshot };`,
    sandbox,
    { filename: 'sw.js' },
  );
  api.sandbox = sandbox;
  api.self = selfObj;
  api.cacheName = sandbox.__sw.CACHE_NAME;
  api.cacheVersion = sandbox.__sw.CACHE_VERSION;
  api.precacheUrls = sandbox.__sw.PRECACHE_URLS;
  api.binding = {
    newClients: sandbox.__sw.newClients,
    clientVersions: sandbox.__sw.clientVersions,
    legacySnapshot: sandbox.__sw.legacySnapshot,
  };
  api.listeners = selfObj.listeners;
  api.waitFor = (event) => {
    const calls = [];
    const fakeEvent = { waitUntil(p) { calls.push(p); } };
    for (const fn of selfObj.listeners[event] || []) fn(fakeEvent);
    return Promise.all(calls);
  };
  // 派发页面 postMessage（client-ready / offline-status）
  api.dispatchMessage = (data, sourceId) => {
    const calls = [];
    const fakeEvent = {
      data,
      source: sourceId ? { id: sourceId } : null,
      ports: [],
      waitUntil(p) { calls.push(p); },
    };
    for (const fn of selfObj.listeners.message || []) fn(fakeEvent);
    return Promise.all(calls);
  };
  return api;
}

const OLD_CACHE_NAME = 'json-three-way-merge-static-v1';

// 构造一套带版本标记的旧版缓存内容
function oldCacheItems() {
  const items = new Map();
  for (const u of PRECACHE_URLS) items.set(u, { from: 'v1', url: u });
  return items;
}

test('install：全部资源成功后整套缓存才存在，且调用 skipWaiting', async () => {
  const api = makeSwSandbox(() => true);
  await api.waitFor('install');
  await api.waitFor('activate');
  const items = api.installed[api.cacheName];
  assert.ok(items, '应创建版本缓存');
  for (const u of api.precacheUrls) assert.ok(items.has(u), `缺少 ${u}`);
  assert.equal(api.self.skipWaitingCalled, 1);
  const okMsg = api.messages.find((m) => m.type === 'precache-ok');
  assert.ok(okMsg && okMsg.isUpdate === false);
});

test('install：任一资源失败时删除整套新缓存、不 skipWaiting、并发来错误说明', async () => {
  const api = makeSwSandbox((u) => (u.includes('/lib/patch.js') ? new Error('HTTP 500') : true));
  await assert.rejects(() => api.waitFor('install'));
  assert.ok(!api.installed[api.cacheName], '失败后不得留下半套缓存');
  assert.equal(api.self.skipWaitingCalled, 0);
  const errMsg = api.messages.find((m) => m.type === 'precache-error');
  assert.ok(errMsg, '应通知页面失败原因');
  assert.match(errMsg.reason, /\/lib\/patch\.js/);
});

test('install（更新场景）：下载失败时旧版缓存原样保留，错误消息标记 isUpdate', async () => {
  const oldName = 'json-three-way-merge-static-v0';
  const api = makeSwSandbox(
    (u) => (u.includes('/app.js') ? new Error('network down') : true),
    { [oldName]: new Map([['/', {}]]) },
  );
  api.self.registration.active = {}; // 有旧 SW 激活中 -> 本次属于更新
  await assert.rejects(() => api.waitFor('install'));
  assert.ok(api.installed[oldName] && api.installed[oldName].has('/'), '旧版缓存必须保留');
  assert.ok(!api.installed[api.cacheName], '新版半成品不得落盘');
  const errMsg = api.messages.find((m) => m.type === 'precache-error');
  assert.ok(errMsg && errMsg.isUpdate === true);
});

test('fetch：只对清单内同源 GET 缓存优先；SW 自身与清单外请求不拦截', async () => {
  const api = makeSwSandbox(() => true);
  await api.waitFor('install');
  await api.waitFor('activate');

  function respond(mode, method, urlString) {
    const req = { method, mode, url: urlString };
    let handled = false;
    const event = {
      request: req,
      respondWith(p) { handled = true; this.promise = p; },
    };
    for (const fn of api.self.listeners.fetch) fn(event);
    return { handled, promise: event.promise };
  }

  // 导航到 /：命中缓存
  const nav = respond('navigate', 'GET', 'http://localhost:8080/');
  assert.ok(nav.handled);
  const navResp = await nav.promise;
  assert.equal(navResp.ok, true);

  // /app.js：命中缓存
  const app = respond('cors', 'GET', 'http://localhost:8080/app.js');
  assert.ok(app.handled);

  // POST 不拦截
  assert.equal(respond('cors', 'POST', 'http://localhost:8080/app.js').handled, false);
  // 跨域不拦截
  assert.equal(respond('cors', 'GET', 'http://example.com/app.js').handled, false);
  // sw.js 本身不拦截
  assert.equal(respond('cors', 'GET', 'http://localhost:8080/sw.js').handled, false);
  // 清单外路径不拦截（不做运行时缓存）
  assert.equal(respond('cors', 'GET', 'http://localhost:8080/other.json').handled, false);
});

// ---------- 更新期间的版本绑定与缓存清理（多标签） ----------

// 派发一个被 SW 处理的 fetch；options 可带 clientId / resultingClientId
function dispatchFetch(api, mode, urlString, options) {
  const opts = options || {};
  const req = { method: 'GET', mode, url: urlString };
  let handled = false;
  const event = {
    request: req,
    clientId: opts.clientId || '',
    resultingClientId: opts.resultingClientId || '',
    respondWith(p) { handled = true; this.promise = p; },
  };
  for (const fn of api.self.listeners.fetch) fn(event);
  return { handled, promise: event.promise };
}

// 安装新版 + 激活，且激活时有旧标签 old-tab 仍存活
async function installUpdateWithOldTab(oldItems) {
  const api = makeSwSandbox(() => true, {
    [OLD_CACHE_NAME]: oldItems || oldCacheItems(),
  });
  api.self.registration.active = {}; // 存在旧 SW -> 本次为更新
  api.setLiveClients(['old-tab']);
  await api.waitFor('install');
  await api.waitFor('activate');
  return api;
}

test('install：下载阶段不创建版本缓存，防止更新下载中被旧 SW 清理误删', async () => {
  const api = makeSwSandbox(() => true);
  const installs = api.waitFor('install');
  // 下载过程中：除最终整体写入外不应提前 open 版本缓存
  assert.ok(!api.openedCacheNames.includes(api.cacheName), '下载未完成前不得创建版本缓存');
  await installs;
  assert.ok(api.openedCacheNames.includes(api.cacheName), '整套下载完成后才创建版本缓存');
});

test('更新激活：仍有旧标签存活时保留旧版缓存，旧标签子资源只拿到旧版完整资源', async () => {
  const api = await installUpdateWithOldTab();
  assert.ok(api.installed[OLD_CACHE_NAME], '旧标签仍开着，旧版缓存不得删除');
  assert.ok(api.binding.legacySnapshot.has('old-tab'), '激活时在场的客户端应保守记为旧版');

  // 旧标签的子资源请求（由旧 SW 或本 SW 处理都一样）：
  // 经本 SW 时必须绑定旧缓存，响应来自 v1
  const sub = dispatchFetch(api, 'cors', 'http://localhost:8080/app.js', { clientId: 'old-tab' });
  const resp = await sub.promise;
  assert.equal(resp.from, 'v1', '旧标签只能取到旧版资源，绝不混用新版');
});

test('更新期间新标签导航：拿到完整新版，且旧标签仍在时旧缓存不清理', async () => {
  const api = await installUpdateWithOldTab();
  api.setLiveClients(['old-tab', 'new-tab']);

  // 新标签导航到 /：响应来自新版缓存，并提前绑定新客户端
  const nav = dispatchFetch(api, 'navigate', 'http://localhost:8080/', {
    clientId: 'old-tab', // 新导航可能由旧文档触发
    resultingClientId: 'new-tab',
  });
  const navResp = await nav.promise;
  assert.notEqual(navResp.from, 'v1', '新导航必须是新版文档');
  assert.ok(api.binding.newClients.has('new-tab'), '导航目标客户端应绑定为新版');
  assert.ok(api.installed[OLD_CACHE_NAME], '旧标签仍存活，旧版缓存必须保留');

  // 新标签自己的子资源来自新版
  const newSub = dispatchFetch(api, 'cors', 'http://localhost:8080/app.js', { clientId: 'new-tab' });
  const newResp = await newSub.promise;
  assert.notEqual(newResp.from, 'v1', '新标签子资源必须来自新版缓存');

  // 旧标签同时段的子资源仍是旧版，新旧不混用
  const oldSub = dispatchFetch(api, 'cors', 'http://localhost:8080/style.css', { clientId: 'old-tab' });
  assert.equal((await oldSub.promise).from, 'v1');
});

test('旧标签全部重载为新版后，才允许删除旧版缓存', async () => {
  const api = await installUpdateWithOldTab();

  // 旧标签点「立即重载」：产生新的 resultingClientId
  api.setLiveClients(['old-tab', 'reloaded-tab']);
  const nav = dispatchFetch(api, 'navigate', 'http://localhost:8080/', {
    clientId: 'old-tab',
    resultingClientId: 'reloaded-tab',
  });
  await nav.promise;
  assert.ok(api.installed[OLD_CACHE_NAME], '旧标签此刻仍存活（重载未完成），旧缓存保留');

  // 旧客户端消失（重载完成 / 关闭），只剩新版客户端：清理
  api.setLiveClients(['reloaded-tab']);
  const sub = dispatchFetch(api, 'cors', 'http://localhost:8080/app.js', { clientId: 'reloaded-tab' });
  await sub.promise; // 该子资源本身不触发清理；再由一次导航 / 上报触发
  await api.dispatchMessage({ type: 'client-ready', version: api.cacheVersion }, 'reloaded-tab');
  assert.ok(!api.installed[OLD_CACHE_NAME], '确认无页面依赖旧版后才删除旧缓存');
});

test('bfcache 恢复旧标签：上报旧版版本，旧缓存继续保留；恢复为新版后才清理', async () => {
  const api = await installUpdateWithOldTab();

  // 旧标签进入 bfcache 时 matchAll 不再枚举它，新导航曾触发过清理；
  // 恢复后它（仍是 v1 页面）上报旧版版本
  api.setLiveClients(['restored-old-tab']);
  await api.dispatchMessage({ type: 'client-ready', version: 'v1' }, 'restored-old-tab');
  assert.ok(api.installed[OLD_CACHE_NAME], '恢复的旧标签仍依赖旧版，缓存不得删除');
  assert.equal(api.binding.clientVersions.get('restored-old-tab'), 'v1');

  const sub = dispatchFetch(api, 'cors', 'http://localhost:8080/app.js', { clientId: 'restored-old-tab' });
  assert.equal((await sub.promise).from, 'v1', '恢复的旧标签子资源仍取旧版');

  // 该标签真正重载为新版并上报当前版本后：可清理
  await api.dispatchMessage({ type: 'client-ready', version: api.cacheVersion }, 'restored-old-tab');
  assert.ok(!api.installed[OLD_CACHE_NAME]);
});

test('激活后新出现但状态未知的客户端：保守保留旧缓存，绝不误删', async () => {
  const api = await installUpdateWithOldTab();
  // 旧标签已关闭，但同时有一个未经导航绑定 / 未上报的未知客户端，
  // 与一个已确认新版的客户端并存
  api.setLiveClients(['mystery-tab', 'known-new-tab']);
  await api.dispatchMessage({ type: 'client-ready', version: api.cacheVersion }, 'known-new-tab');
  assert.ok(api.installed[OLD_CACHE_NAME], '状态未知的客户端存活时必须保留旧缓存');

  // 未知客户端也确认切到新版后，才允许清理
  api.setLiveClients(['known-new-tab', 'mystery-tab']);
  await api.dispatchMessage({ type: 'client-ready', version: api.cacheVersion }, 'mystery-tab');
  assert.ok(!api.installed[OLD_CACHE_NAME], '全部客户端确认新版后才删除旧缓存');
});

test('新版下载中断：不生成新缓存、不接管，旧版整套缓存原样可离线使用', async () => {
  const api = makeSwSandbox(
    (u) => (u.includes('/lib/patch.js') ? new Error('network down') : true),
    { [OLD_CACHE_NAME]: oldCacheItems() },
  );
  api.self.registration.active = {};
  api.setLiveClients(['old-tab']);
  await assert.rejects(() => api.waitFor('install'));
  assert.equal(api.self.skipWaitingCalled, 0, '下载中断不得 skipWaiting');
  assert.ok(!api.installed[api.cacheName], '不得留下半套新缓存');
  const oldItems = api.installed[OLD_CACHE_NAME];
  assert.ok(oldItems, '旧版缓存必须保留');
  for (const u of api.precacheUrls) {
    assert.ok(oldItems.has(u), `旧版完整资源保留：${u}`);
  }
  const errMsg = api.messages.find((m) => m.type === 'precache-error');
  assert.ok(errMsg && errMsg.isUpdate === true, '页面提示须反映：更新失败、旧版继续可用');
});

test('清理只删除比本 SW 更旧的缓存：存在更新版本缓存时绝不误删', async () => {
  // v0 更旧、v3 更新（极端多版本并存场景）；当前 v2 SW 清理后应只删 v0
  const api = makeSwSandbox(() => true, {
    'json-three-way-merge-static-v0': new Map([['/', {}]]),
    'json-three-way-merge-static-v3': new Map([['/', {}]]),
  });
  // 激活时没有任何存活客户端 -> 允许清理
  api.setLiveClients([]);
  await api.waitFor('install');
  await api.waitFor('activate');
  assert.ok(!api.installed['json-three-way-merge-static-v0'], '比当前旧的缓存应清理');
  assert.ok(api.installed['json-three-way-merge-static-v3'], '更新版本的缓存绝不能被旧 SW 删除');
});

test('offline.js 的 APP_VERSION 与 sw.js 的 CACHE_VERSION 一致（页面提示反映实际版本）', () => {
  const offlineSource = fs.readFileSync(path.join(PUBLIC_DIR, 'offline.js'), 'utf8');
  const m = offlineSource.match(/const APP_VERSION = '(v\d+)'/);
  assert.ok(m, 'offline.js 应声明 APP_VERSION 常量');
  assert.equal(m[1], CACHE_VERSION, '页面版本与 SW 缓存版本必须同步递增');
});

