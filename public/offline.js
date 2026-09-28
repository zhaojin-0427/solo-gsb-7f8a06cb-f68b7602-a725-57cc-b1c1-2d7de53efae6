'use strict';

/*
 * Service Worker 注册与离线状态提示。
 *
 * 状态徽标始终挂在页面顶部（#offlineStatus），所有提示都带版本号，
 * 反映「本标签实际可用的版本」：
 *  - preparing 首次访问正在整套预缓存：提示「正在准备离线资源…」
 *  - ready     本版整套静态资源已缓存：提示「可离线使用（vN）」
 *  - error     整套缓存中有任何资源下载失败：说明具体失败原因，
 *              旧版仍在时明确「继续使用旧版 vN」，并提供「重试」
 *  - updating  新版已整套下载完成；本标签重载前仍运行并可离线使用旧版，
 *              提示实际可用版本与待生效版本，提供「立即重载」
 *  - unsupported 非安全上下文（非 http://localhost 也非 https）或浏览器
 *              不支持 SW：只说明原因，不影响在线使用
 *
 * 多标签更新时，页面会在加载 / bfcache 恢复 / 控制器切换后向 SW 上报本页
 * 资源版本（client-ready），SW 据此把每个标签绑定到对应整套缓存，并在
 * 确认没有页面依赖旧版后才删除旧缓存。
 *
 * 草稿仍保存在 app.js 使用的 localStorage 中，与本脚本无关。
 */
(function () {
  const SW_URL = '/sw.js';
  // 本页面（随 HTML 一起加载的这套脚本）所属的资源版本。
  // 必须与 public/sw.js 顶部的 CACHE_VERSION 保持一致（测试会核对）。
  const APP_VERSION = 'v2';
  // 与 sw.js 中的缓存名前缀保持一致，仅用于在注册前同步探测是否已缓存过
  const CACHE_PREFIX = 'json-three-way-merge-static-';

  const box = document.getElementById('offlineStatus');

  let phase = 'preparing'; // preparing | ready | error | updating | unsupported
  let lastReason = '';
  let lastIsUpdate = false;
  let offline = !navigator.onLine;

  function render() {
    if (!box) return;
    box.innerHTML = '';
    box.classList.remove('ready', 'error', 'preparing', 'updating', 'unsupported');
    box.classList.add(phase);

    const dot = document.createElement('span');
    dot.className = 'os-dot';
    const text = document.createElement('span');
    text.className = 'os-text';
    box.append(dot, text);

    const net = offline ? '（当前已断网）' : '';

    if (phase === 'preparing') {
      dot.textContent = '⏳';
      text.textContent = `正在准备 ${APP_VERSION} 版离线资源：页面、样式、全部业务脚本与本地 Ajv 必须整套缓存成功后才可离线使用…`;
      return;
    }
    if (phase === 'ready') {
      dot.textContent = '✅';
      text.textContent = `${APP_VERSION} 版可离线使用${net}：断网或停止容器后，重开 http://localhost:8080 仍可合并、校验、恢复草稿与导出。草稿仅保存在本浏览器本地存储中。`;
      return;
    }
    if (phase === 'unsupported') {
      dot.textContent = 'ℹ️';
      text.textContent = '当前环境不支持离线缓存（Service Worker 仅在 http://localhost 或 https 下可用，或浏览器已禁用）：在线使用不受影响，草稿仍可本地保存。';
      return;
    }
    if (phase === 'error') {
      dot.textContent = '⚠️';
      const head = document.createElement('span');
      head.textContent = (lastIsUpdate
        ? `新版（${APP_VERSION}）离线资源未能整套下载，本标签继续使用旧版（重载前不会混用新旧脚本），旧版离线能力不受影响。`
        : `${APP_VERSION} 版离线资源尚未准备完成，暂时不能离线使用。`)
        + '原因：' + lastReason + ' 修复网络后可重试。';
      text.appendChild(head);
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'os-retry';
      retry.textContent = '重试准备';
      retry.addEventListener('click', retryPreparation);
      box.appendChild(retry);
      return;
    }
    // updating
    dot.textContent = '🔄';
    const head = document.createElement('span');
    head.textContent = `新版静态资源已整套缓存完成：当前本标签实际运行的是 ${APP_VERSION} 版（断网也仍可离线使用本版），`
      + '重载后才切到新版；重载前新旧脚本不会混用。另一个标签可直接打开新版页面。'
      + '全部旧标签都重载或关闭后，旧版缓存才会自动清理。';
    text.appendChild(head);
    const reload = document.createElement('button');
    reload.type = 'button';
    reload.className = 'os-retry';
    reload.textContent = '立即重载';
    reload.addEventListener('click', () => window.location.reload());
    box.appendChild(reload);
  }

  // 不支持 / 注册失败：说明原因，不影响页面其它功能
  function markUnsupported(message) {
    phase = 'unsupported';
    if (message) lastReason = message;
    render();
  }

  function markReady(isUpdate) {
    phase = isUpdate ? 'updating' : 'ready';
    lastReason = '';
    render();
  }

  function markError(reason, isUpdate) {
    phase = 'error';
    lastReason = reason || '未知错误';
    lastIsUpdate = Boolean(isUpdate);
    render();
  }

  // 向 SW 上报「本标签正在运行的资源版本」：SW 据此做版本绑定，
  // 并在确认无旧版依赖者后清理旧缓存。加载、bfcache 恢复、控制器切换都报一次。
  function announceClientReady() {
    if (!navigator.serviceWorker) return;
    const worker = navigator.serviceWorker.controller;
    if (!worker) return;
    try {
      worker.postMessage({ type: 'client-ready', version: APP_VERSION });
    } catch {
      // 上报失败不影响页面功能：SW 侧还有导航绑定与保守保留旧缓存兜底
    }
  }

  // 向 SW 查询整套缓存是否已就绪（页面错过 SW 的 postMessage 时的兜底）
  function queryStatus(registration) {
    const worker = registration.active;
    if (!worker) return;
    const channel = new MessageChannel();
    channel.port1.onmessage = (e) => {
      const d = e.data || {};
      if (d.type === 'offline-status-result') {
        if (d.ok) {
          // 已存在一整套缓存：是此前已准备好的版本；更新安装另有事件通知
          if (phase === 'preparing') markReady(false);
        }
      }
    };
    try {
      worker.postMessage({ type: 'offline-status' }, [channel.port2]);
    } catch {
      // 查询不到就等 SW 的事件通知
    }
  }

  async function probeExistingCache() {
    // 注册前先同步给「此前已准备好」的用户一个确定状态，
    // 避免每次重开都先闪一下「正在准备」
    try {
      if (!window.caches) return false;
      const names = await caches.keys();
      return names.some((n) => n.startsWith(CACHE_PREFIX));
    } catch {
      return false;
    }
  }

  function watchRegistration(registration) {
    // 新版下载完成 / 失败由 installing worker 的 statechange 捕获。
    // 注册瞬间已存在的 installing worker 可能是首次安装，也可能是更新；
    // updatefound 之后出现的则一定是更新。
    const track = (worker, isUpdateHint) => {
      if (!worker) return;
      worker.addEventListener('statechange', () => {
        if (worker.state === 'redundant') {
          // install 抛错即变为 redundant：具体原因以 SW 发来的
          // precache-error 消息为准；若消息错过，这里兜底提示重试
          if (phase !== 'error') {
            const isUpdate = typeof isUpdateHint === 'boolean'
              ? isUpdateHint
              : Boolean(registration.active || navigator.serviceWorker.controller);
            markError('有静态资源下载失败或写入失败，整套缓存未生成。', isUpdate);
          }
        }
      });
    };
    track(registration.installing);
    registration.addEventListener('updatefound', () => track(registration.installing, true));
  }

  function listenToWorkerMessages() {
    if (!navigator.serviceWorker) return;
    navigator.serviceWorker.addEventListener('message', (e) => {
      const d = e.data || {};
      if (d.type === 'precache-ok') {
        markReady(Boolean(d.isUpdate));
      } else if (d.type === 'precache-error') {
        markError(d.reason || '有静态资源下载失败。', Boolean(d.isUpdate));
      }
    });
    // 新 SW 接管本标签（重载后）：重新上报本页版本
    navigator.serviceWorker.addEventListener('controllerchange', announceClientReady);
    // bfcache 恢复时不会重新执行脚本、也不产生导航请求：
    // 主动再报一次版本，避免 SW 把恢复的旧标签误判为已离开而删掉旧缓存
    window.addEventListener('pageshow', (e) => {
      if (e.persisted) announceClientReady();
    });
  }

  async function retryPreparation() {
    phase = 'preparing';
    render();
    try {
      const reg = await navigator.serviceWorker.getRegistration(SW_URL);
      if (reg) await reg.update();
      else await navigator.serviceWorker.register(SW_URL);
    } catch (err) {
      markError('重新注册 Service Worker 失败：' + ((err && err.message) || err), lastIsUpdate);
    }
  }

  window.addEventListener('online', () => { offline = false; if (phase === 'ready' || phase === 'updating') render(); });
  window.addEventListener('offline', () => { offline = true; if (phase === 'ready' || phase === 'updating') render(); });

  (async () => {
    if (!('serviceWorker' in navigator) || !window.caches) {
      markUnsupported();
      return;
    }
    // file:// 或非 localhost 的 http 属于不受支持的上下文
    const isLocalhost = ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
    if (window.location.protocol === 'http:' && !isLocalhost) {
      markUnsupported();
      return;
    }

    listenToWorkerMessages();

    // 重开页面时（含断网重开）：此前已整套缓存就直接显示「可离线使用」
    const hadCache = await probeExistingCache();
    if (hadCache) {
      phase = 'ready';
      render();
    }

    let registration;
    try {
      registration = await navigator.serviceWorker.register(SW_URL);
    } catch (err) {
      // 注册失败时若本地已有缓存（如断网导致字节校验更新失败），
      // 离线能力仍然有效，不应覆盖为错误
      if (!hadCache) markError('Service Worker 注册失败：' + ((err && err.message) || err), false);
      return;
    }

    watchRegistration(registration);

    // 已被 SW 控制或已有激活 worker：查询一次当前版本的完整性
    if (registration.active) queryStatus(registration);

    // 首次安装：等待 installing/activated，期间主要靠 SW 的消息通知；
    // 激活后若仍停留在 preparing（消息错过），再查一次状态兜底
    const worker = registration.installing || registration.waiting;
    if (worker) {
      worker.addEventListener('statechange', () => {
        if (worker.state === 'activated' && phase === 'preparing') queryStatus(registration);
      });
    }
    navigator.serviceWorker.ready.then((reg) => {
      if (phase === 'preparing') queryStatus(reg);
    }).catch(() => { /* 忽略：错误事件已覆盖 */ });

    // 注册完成后（此时 navigator.serviceWorker.controller 可能已就绪）
    // 上报一次本页版本
    announceClientReady();
  })();
})();
