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
const offlineSource = fs.readFileSync(path.join(PUBLIC_DIR, 'offline.js'), 'utf8');

test('sw.js CACHE_VERSION 与 offline.js APP_VERSION 一致（页面据此应答版本核对）', () => {
  const swVersion = swSource.match(/const\s+CACHE_VERSION\s*=\s*'(v\d+)'/);
  const appVersion = offlineSource.match(/const\s+APP_VERSION\s*=\s*'(v\d+)'/);
  assert.ok(swVersion, 'sw.js 应声明 CACHE_VERSION');
  assert.ok(appVersion, 'offline.js 应声明 APP_VERSION');
  assert.equal(swVersion[1], appVersion[1]);
});

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
  vm.runInContext(`${swSource}\n;globalThis.__sw = { CACHE_NAME, PRECACHE_URLS };`, sandbox, { filename: 'sw.js' });
  return { sandbox, listeners };
}

const { sandbox, listeners } = loadSwModule();
const CACHE_NAME = sandbox.__sw.CACHE_NAME;
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
// fakeCaches 模拟 CacheStorage 中各命名缓存的内容；
// makeClients(makeClient) 返回模拟窗口列表，用于版本核对与旧缓存清理时机。
function makeSwSandbox(fetchImpl, initialCaches, makeClients) {
  const installed = initialCaches || {};
  const messages = [];
  const api = { listeners: {}, messages, installed };

  class FakeCache {
    constructor(name) { this.name = name; this.items = installed[name] || new Map(); }
    async put(req, resp) {
      const u = typeof req === 'string' ? req : new URL(req.url).pathname;
      this.items.set(u, resp);
      installed[this.name] = this.items;
    }
    async keys() { return [...this.items.keys()].map((u) => ({ url: `http://localhost:8080${u}` })); }
  }

  // 沙箱内可控的定时器：advanceTimersAndMicrotasks 让 pending 的
  // ping 超时立刻到期，避免真实等待
  const timers = new Map();
  let nextTimerId = 1;
  const sandboxTimers = {
    setTimeout(fn) { const id = nextTimerId++; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  async function advanceTimersAndMicrotasks() {
    // pong 经多层微任务回调（postMessage -> port 回调），先排空微任务队列
    // 若干轮，让应答先于下方的超时生效；再触发仍 pending 的超时
    for (let i = 0; i < 6; i++) await Promise.resolve();
    const pending = [...timers.values()];
    timers.clear();
    pending.forEach((fn) => fn());
    for (let i = 0; i < 6; i++) await Promise.resolve();
  }

  // 模拟 MessageChannel：port2 被 transfer 给「页面」，其 postMessage
  // 经微任务回调到 SW 持有的 port1.onmessage
  class FakeMessageChannel {
    constructor() {
      this.port1 = {
        onmessage: null,
        close() {},
      };
      this.port2 = {
        onmessage: null,
        close() {},
        postMessage: (data) => {
          Promise.resolve().then(() => {
            if (this.port1.onmessage) this.port1.onmessage({ data });
          });
        },
      };
    }
  }

  // 模拟一个窗口客户端：options.version 设定收到 version-ping 时的应答；
  // 缺省 / null 表示「不回应」（模拟没有应答逻辑的旧版页面）
  function makeClient(id, options) {
    const opts = options || {};
    return {
      id,
      url: 'http://localhost:8080/',
      postMessage(data, transfer) {
        messages.push(data);
        if (data && data.type === 'version-ping') {
          const port = transfer && transfer[0];
          if (port && opts.version) {
            Promise.resolve().then(() => port.postMessage({ type: 'version-pong', version: opts.version }));
          }
        }
      },
    };
  }

  const clientsList = makeClients ? makeClients(makeClient) : [];

  const sandbox = {
    URL,
    Response: class {
      constructor(ok) { this.ok = ok !== false; }
      clone() { return this; }
    },
    console: { log() {}, warn() {}, error() {} },
    MessageChannel: FakeMessageChannel,
    setTimeout: sandboxTimers.setTimeout,
    clearTimeout: sandboxTimers.clearTimeout,
    fetch: async (u) => {
      const r = fetchImpl(String(u));
      if (r instanceof Error) throw r;
      return new sandbox.Response(r);
    },
    caches: {
      async open(name) { return new FakeCache(name); },
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
    clients: {
      async matchAll() { return clientsList; },
    },
    registration: { active: null },
    addEventListener(type, fn) {
      selfObj.listeners[type] = selfObj.listeners[type] || [];
      selfObj.listeners[type].push(fn);
    },
  };
  sandbox.self = selfObj;

  vm.createContext(sandbox);
  vm.runInContext(`${swSource}\n;globalThis.__sw = { CACHE_NAME, PRECACHE_URLS };`, sandbox, { filename: 'sw.js' });
  api.sandbox = sandbox;
  api.self = selfObj;
  api.cacheName = sandbox.__sw.CACHE_NAME;
  api.precacheUrls = sandbox.__sw.PRECACHE_URLS;
  api.listeners = selfObj.listeners;
  api.clientsList = clientsList;
  api.makeClient = makeClient;
  api.advanceTimersAndMicrotasks = advanceTimersAndMicrotasks;
  // 向 SW 投递一条来自页面的消息（模拟 client-ready / client-closed 等）
  api.postMessageToSw = async (data) => {
    const event = { data, source: null, ports: [], waitUntil() {} };
    for (const fn of selfObj.listeners.message || []) fn(event);
    await Promise.resolve();
    await Promise.resolve();
  };
  api.waitFor = (event) => {
    const calls = [];
    const fakeEvent = { waitUntil(p) { calls.push(p); } };
    for (const fn of selfObj.listeners[event] || []) fn(fakeEvent);
    return Promise.all(calls);
  };
  return api;
}

test('install：全部资源成功后整套缓存才存在，且调用 skipWaiting', async () => {
  // 一个已打开的页面（不应答版本 ping 也不影响 install）：用于接收通知消息
  const api = makeSwSandbox(() => true, null, (makeClient) => [makeClient('page')]);
  await api.waitFor('install');
  const items = api.installed[api.cacheName];
  assert.ok(items, '应创建版本缓存');
  for (const u of api.precacheUrls) assert.ok(items.has(u), `缺少 ${u}`);
  assert.equal(api.self.skipWaitingCalled, 1);
  const okMsg = api.messages.find((m) => m.type === 'precache-ok');
  assert.ok(okMsg && okMsg.isUpdate === false);
});

test('install：任一资源失败时删除整套新缓存、不 skipWaiting、并发来错误说明', async () => {
  const api = makeSwSandbox(
    (u) => (u.includes('/lib/patch.js') ? new Error('HTTP 500') : true),
    null,
    (makeClient) => [makeClient('page')],
  );
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
    (makeClient) => [makeClient('page')],
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

// ---------- 旧缓存清理时机：确认没有页面依赖旧版后才删除 ----------

const SW_VERSION = swSource.match(/const\s+CACHE_VERSION\s*=\s*'(v\d+)'/)[1];
const OLD_CACHE_NAME = 'json-three-way-merge-static-v0';

// 触发一次新版导航（/），随后返回导航响应的 Promise（清理在其后异步进行）
function navigate(api) {
  const event = {
    request: { method: 'GET', mode: 'navigate', url: 'http://localhost:8080/' },
    respondWith(p) { this.promise = p; },
  };
  for (const fn of api.self.listeners.fetch) fn(event);
  return event.promise;
}

test('offline.js：语法合法、声明 APP_VERSION 并应答 version-ping', () => {
  const offlinePath = path.join(PUBLIC_DIR, 'offline.js');
  execFileSync(process.execPath, ['--check', offlinePath]);
  assert.match(offlineSource, /const\s+APP_VERSION\s*=\s*'v\d+'/);
  // 无条件应答 version-ping（准备中 / 出错时也不能让 SW 误删旧缓存）
  assert.match(offlineSource, /d\.type\s*===\s*'version-ping'/);
  assert.match(offlineSource, /type:\s*'version-pong'/);
  // 页面加载完成与关闭时通知 SW 触发清理核对
  assert.match(offlineSource, /'client-ready'/);
  assert.match(offlineSource, /'client-closed'/);
});

test('旧缓存清理：无其它窗口时，新版导航后删除旧版本缓存', async () => {
  const api = makeSwSandbox(
    () => true,
    { [OLD_CACHE_NAME]: new Map([['/', {}]]) },
  );
  await api.waitFor('install');
  assert.ok(api.installed[OLD_CACHE_NAME], '前置：旧缓存存在');

  await navigate(api);
  await api.advanceTimersAndMicrotasks();

  assert.ok(!api.installed[OLD_CACHE_NAME], '没有页面依赖旧版时应删除旧缓存');
  assert.ok(api.installed[api.cacheName], '当前版本缓存必须保留');
});

test('旧缓存清理：仍有标签应答旧版本时，新版导航也不得删除旧缓存', async () => {
  const api = makeSwSandbox(
    () => true,
    { [OLD_CACHE_NAME]: new Map([['/', {}]]) },
    (makeClient) => [makeClient('old-tab', { version: 'v0' })],
  );
  await api.waitFor('install');

  await navigate(api);
  await api.advanceTimersAndMicrotasks();

  assert.ok(api.installed[OLD_CACHE_NAME], '旧版标签仍开着，旧缓存必须保留');
  assert.ok(api.installed[api.cacheName], '新版缓存同时保留（两版并存至旧标签消失）');
});

test('旧缓存清理：旧版页面没有应答逻辑（超时）时保留旧缓存；关闭后下一次清理才删除', async () => {
  const api = makeSwSandbox(
    () => true,
    { [OLD_CACHE_NAME]: new Map([['/', {}]]) },
    // 不传 version -> 永不 pong，模拟没有版本应答逻辑的旧版页面
    (makeClient) => [makeClient('old-tab')],
  );
  await api.waitFor('install');

  await navigate(api);
  await api.advanceTimersAndMicrotasks();
  assert.ok(api.installed[OLD_CACHE_NAME], '旧版页面无应答：按仍依赖旧版处理，保留缓存');

  // 最后一个旧版标签关闭：窗口列表清空，页面发来 client-closed
  api.clientsList.length = 0;
  await api.postMessageToSw({ type: 'client-closed' });
  await api.advanceTimersAndMicrotasks();
  assert.ok(!api.installed[OLD_CACHE_NAME], '旧版标签全部消失后才允许删除旧缓存');
});

test('旧缓存清理：旧标签重载为新版（应答当前版本）后删除旧缓存', async () => {
  const api = makeSwSandbox(
    () => true,
    { [OLD_CACHE_NAME]: new Map([['/', {}]]) },
    (makeClient) => [makeClient('tab', { version: 'v0' })],
  );
  await api.waitFor('install');

  await navigate(api);
  await api.advanceTimersAndMicrotasks();
  assert.ok(api.installed[OLD_CACHE_NAME], '前置：旧标签应答 v0，旧缓存保留');

  // 同一标签重载后运行新版脚本，应答当前版本
  api.clientsList[0] = api.makeClient('tab', { version: SW_VERSION });
  await navigate(api);
  await api.advanceTimersAndMicrotasks();
  assert.ok(!api.installed[OLD_CACHE_NAME], '全部标签都在新版后删除旧缓存');
});

test('旧缓存清理：新版窗口与无应答旧窗口并存时保留；只剩新版窗口后才删除', async () => {
  const api = makeSwSandbox(
    () => true,
    { [OLD_CACHE_NAME]: new Map([['/', {}]]) },
    (makeClient) => [
      makeClient('new-tab', { version: SW_VERSION }),
      makeClient('old-tab'), // 旧版页面：不应答
    ],
  );
  await api.waitFor('install');

  await navigate(api);
  await api.advanceTimersAndMicrotasks();
  assert.ok(api.installed[OLD_CACHE_NAME], '多标签：一个新、一个旧（无应答）时保留旧缓存');

  // 旧标签关闭（模拟关闭事件通知 + 窗口列表移除）
  api.clientsList.splice(1, 1);
  await api.postMessageToSw({ type: 'client-closed' });
  await api.advanceTimersAndMicrotasks();
  assert.ok(!api.installed[OLD_CACHE_NAME], '旧标签关闭后清理旧缓存');
});

test('fetch：只读本 SW 自己版本的缓存，旧缓存同路径条目不会被新版页面取用', async () => {
  // 旧缓存里的 / 标记为旧响应；新版缓存已整套安装。新版导航必须返回新版条目
  const oldEntry = { from: 'old-cache' };
  const api = makeSwSandbox(
    () => true,
    { [OLD_CACHE_NAME]: new Map([['/', oldEntry]]) },
  );
  await api.waitFor('install');
  const resp = await navigate(api);
  assert.notEqual(resp, oldEntry, '新版页面不得取到旧缓存中的资源');
});

