// 静态缓存版本号（应用更新时递增）
const CACHE = 'cloud-album-shell-v3.0.6';
// 预缓存核心资源列表
const SHELL = ['./', './index.html', './css/app.css', './js/app.js', './js/r2.js', './js/index-store.js', './icons/icon.svg', './manifest.webmanifest'];

// 安装阶段：预缓存核心静态文件
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(SHELL))
  );
});

// 激活阶段：清理过期的旧版本缓存，并接管客户端
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.map(key => {
          if (key !== CACHE) {
            console.log('[Service Worker] 清理旧缓存版本:', key);
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// 监听客户端发送的指令（支持用户触发立即更新）
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// 请求拦截阶段
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);

  // 1. 处理 Web Share Target 图片分享
  if (request.method === 'POST' && url.origin === location.origin) {
    event.respondWith((async () => {
      const data = await request.formData();
      const files = data.getAll('images').filter(value => value instanceof File);
      const cache = await caches.open(CACHE);
      await cache.put('./shared-files', new Response(JSON.stringify(await Promise.all(files.map(async file => ({
        name: file.name, type: file.type, data: Array.from(new Uint8Array(await file.arrayBuffer()))
      }))))));
      return Response.redirect('./?share-target=1', 303);
    })());
    return;
  }

  // 过滤非 GET 请求或图片资源
  if (request.method !== 'GET' || request.destination === 'image') return;

  // 2. 对于 HTML 入口文件采用 Network-First（网络优先），确保页面结构始终最新
  const isHtml = request.mode === 'navigate' || request.headers.get('accept')?.includes('text/html') || url.pathname.endsWith('.html') || url.pathname === '/' || url.pathname.endsWith('/');
  if (isHtml && url.origin === location.origin) {
    event.respondWith(
      fetch(request).then(response => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE).then(cache => cache.put(request, clone));
        }
        return response;
      }).catch(() => {
        // 网络不可用时回退到本地缓存（保证离线可用）
        return caches.match(request).then(hit => hit || caches.match('./index.html') || caches.match('./'));
      })
    );
    return;
  }

  // 3. 其它同源静态资源（CSS/JS/图标等）采用 Cache-First 结合回填策略
  event.respondWith(
    caches.match(request).then(hit => {
      if (hit) return hit;
      return fetch(request).then(response => {
        if (url.origin === location.origin && response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE).then(cache => cache.put(request, clone));
        }
        return response;
      });
    })
  );
});
