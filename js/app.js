/**
 * 云端相册主程序 (Cloud Photo Gallery)
 * 具备以下特性：
 * 1. 响应式布局：PC端与移动端分层设计，顶部第一行搜索栏，第二行功能标签与排序
 * 2. 排序引擎：支持按修改/拍摄日期（默认倒序）或按文件大小排序
 * 3. 滚动分批与无限滚动加载：避免一次性渲染海量图片导致卡顿
 * 4. 勾选多选：每张图片左上方提供多选勾选框，支持单选/多选/全选
 * 5. 底部固定操作栏：上传、下载、删除（删除在有选中项时高亮点亮）
 * 6. 网页底端回到顶部按钮：平滑滚动与滚动显示控制
 */

import { R2 } from './r2.js';
import { config, loadIndex, saveIndex } from './index-store.js';
import { clearUploadLogs, createUploadLog, finishUploadLog, listUploadLogs } from './upload-log.js';

// DOM 根容器与文件选择器
const app = document.querySelector('#app');
const input = document.querySelector('#file-input');

// 全局应用状态
let r2 = null;
let index = { photos: [], albums: [] };
let view = 'timeline'; // 'timeline' | 'albums' | 'trash'
let currentAlbum = '全部';
let sortBy = 'date-desc'; // 'date-desc' | 'date-asc' | 'size-desc' | 'size-asc'
let searchQuery = '';
let selected = new Set(); // 存储选中的照片 ID
let currentViewerIndex = 0;

// 分批与无限滚动加载控制
const PAGE_SIZE = 24; // 每次加载数量
let visibleCount = PAGE_SIZE;
let filteredPhotos = []; // 当前过滤与排序后的所有照片列表
let intersectionObserver = null;

// 工具辅助函数
const APP_VERSION = 'v3.0.2'; // 与 Service Worker 缓存和发布版本保持同步
let swRegistration = null;
let isRefreshing = false;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const format = value => new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium' }).format(new Date(value));
const formatDateTime = value => value ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(value)) : '-';
const formatSize = value => {
  if (!Number.isFinite(value)) return '-';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value / 1024 < 10 ? 1 : 0)} KB`;
  return `${(value / (1024 * 1024)).toFixed(value / (1024 * 1024) < 10 ? 1 : 0)} MB`;
};
const uuid = () => crypto.randomUUID();

/**
 * 内存图片缓存管理器 (LRU Cache)
 * 缓存已加载的 Blob URL 与网络 Promise，避免同一张图片重复请求网络并实现毫秒级秒开
 */
const imageMemoryCache = new Map();
const MAX_MEMORY_CACHE_SIZE = 30;

function getCachedImageUrl(key) {
  if (!imageMemoryCache.has(key)) return null;
  const item = imageMemoryCache.get(key);
  // LRU 机制：提到最前
  imageMemoryCache.delete(key);
  imageMemoryCache.set(key, item);
  return item.url;
}

function setCachedImageUrl(key, url, isBlob = false) {
  if (imageMemoryCache.has(key)) {
    imageMemoryCache.delete(key);
  } else if (imageMemoryCache.size >= MAX_MEMORY_CACHE_SIZE) {
    // 淘汰最久未使用的项并释放 ObjectURL 内存
    const oldestKey = imageMemoryCache.keys().next().value;
    const oldest = imageMemoryCache.get(oldestKey);
    if (oldest?.isBlob && oldest.url) {
      try { URL.revokeObjectURL(oldest.url); } catch {}
    }
    imageMemoryCache.delete(oldestKey);
  }
  imageMemoryCache.set(key, { url, isBlob, time: Date.now() });
}

// 记录当前活跃的预加载 Promise，防止重复请求
const activePreloadTasks = new Map();

/**
 * 获取或加载高清大图（支持 LRU 缓存与 R2 Blob / 直链加载）
 */
async function loadPhotoHighResUrl(key) {
  if (!key) return '';
  const cached = getCachedImageUrl(key);
  if (cached) return cached;

  if (activePreloadTasks.has(key)) {
    return activePreloadTasks.get(key);
  }

  const task = (async () => {
    const publicUrl = getPublicImageUrl(key);
    if (publicUrl) {
      // 预先检测直链是否可用
      try {
        await new Promise((resolve, reject) => {
          const probe = new Image();
          probe.onload = () => resolve(publicUrl);
          probe.onerror = () => reject(new Error('直链加载失败'));
          probe.src = publicUrl;
        });
        setCachedImageUrl(key, publicUrl, false);
        return publicUrl;
      } catch {
        // 直链失败回退到 R2 SDK 拉取 Blob
      }
    }

    const response = await r2.get(key);
    const blob = await response.blob();
    const blobUrl = URL.createObjectURL(blob);
    setCachedImageUrl(key, blobUrl, true);
    return blobUrl;
  })();

  activePreloadTasks.set(key, task);
  try {
    const res = await task;
    return res;
  } finally {
    activePreloadTasks.delete(key);
  }
}

/**
 * 预加载单张照片
 */
function preloadPhoto(photo) {
  if (!photo?.key) return;
  if (getCachedImageUrl(photo.key) || activePreloadTasks.has(photo.key)) return;
  loadPhotoHighResUrl(photo.key).catch(() => {});
}

/**
 * 统一获取图片公开外链/直链 URL (base + '/' + key)
 * @param {string} key 对象的 key 路径
 * @returns {string} 拼接好的外链 URL，若未配置域名则返回空字符串
 */
function getPublicImageUrl(key) {
  const base = config.getImgBaseUrl();
  if (!base || !key) return '';
  const cleanKey = String(key).replace(/^\/+/, '');
  return `${base}/${cleanKey}`;
}

/**
 * 快捷复制文本到剪贴板
 */
async function copyToClipboard(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.opacity = '0';
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    const successful = document.execCommand('copy');
    document.body.removeChild(textArea);
    return successful;
  } catch (e) {
    console.error('复制失败:', e);
    return false;
  }
}

/**
 * Service Worker 更新与通知机制
 */
function triggerSwUpdate(worker) {
  if (worker) {
    worker.postMessage({ type: 'SKIP_WAITING' });
  }
}

function showUpdateBanner(worker) {
  const banner = document.querySelector('#update-banner');
  const btnNow = document.querySelector('#btn-update-now');
  const btnDismiss = document.querySelector('#btn-update-dismiss');
  if (!banner) return;

  banner.hidden = false;
  if (btnNow) {
    btnNow.onclick = () => {
      btnNow.disabled = true;
      btnNow.textContent = '正在更新...';
      triggerSwUpdate(worker);
    };
  }
  if (btnDismiss) {
    btnDismiss.onclick = () => {
      banner.hidden = true;
    };
  }
}

function setupServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  // 监听 controllerchange：当新 worker 激活接管后，页面自动刷新
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!isRefreshing) {
      isRefreshing = true;
      window.location.reload();
    }
  });

  navigator.serviceWorker.register('./sw.js').then(reg => {
    swRegistration = reg;

    // 如果注册时就已经有 waiting 状态的新 worker
    if (reg.waiting) {
      showUpdateBanner(reg.waiting);
    }

    // 监听是否有新的 Service Worker 正在安装
    reg.addEventListener('updatefound', () => {
      const newWorker = reg.installing;
      if (!newWorker) return;

      newWorker.addEventListener('statechange', () => {
        // 如果安装完成且当前页面已有激活的 SW 控制（说明是更新而非初次安装）
        if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
          showUpdateBanner(newWorker);
        }
      });
    });
  }).catch(err => {
    console.warn('[SW] 注册失败:', err);
  });
}

/**
 * 初始化入口
 */
async function init() {
  setupServiceWorker();
  
  const saved = config.get();
  if (!saved) {
    return renderSetup();
  }
  
  r2 = new R2(saved);
  try {
    index = await loadIndex(r2);
    await receiveShared();
    renderApp();
  } catch (error) {
    console.error('无法读取相册数据:', error);
    toast(`无法读取相册：${error.message}`, true);
    renderSetup(saved);
  }
}

/**
 * 过滤与排序核心方法
 */
function updateFilteredPhotos() {
  let list = index.photos.filter(photo => view === 'trash' ? photo.trashed : !photo.trashed);

  // 相册过滤
  if (view === 'albums' && currentAlbum !== '全部') {
    if (currentAlbum === '未分类') {
      list = list.filter(p => !p.album);
    } else {
      list = list.filter(p => p.album === currentAlbum);
    }
  }

  // 搜索关键字过滤
  if (searchQuery.trim()) {
    const q = searchQuery.trim().toLowerCase();
    list = list.filter(p => (p.name && p.name.toLowerCase().includes(q)) || (p.album && p.album.toLowerCase().includes(q)));
  }

  // 排序规则
  list.sort((a, b) => {
    const timeA = new Date(a.takenAt || a.uploadedAt || 0).getTime();
    const timeB = new Date(b.takenAt || b.uploadedAt || 0).getTime();
    const sizeA = Number(a.size) || 0;
    const sizeB = Number(b.size) || 0;

    switch (sortBy) {
      case 'date-asc':
        return timeA - timeB;
      case 'size-desc':
        return sizeB - sizeA;
      case 'size-asc':
        return sizeA - sizeB;
      case 'date-desc':
      default:
        return timeB - timeA;
    }
  });

  filteredPhotos = list;
}

/**
 * 主界面渲染
 */
function renderApp() {
  updateFilteredPhotos();

  // 顶部第一行：搜索框与功能图标
  const currentBaseUrl = config.getImgBaseUrl();
  const topSearchRow = `
    <div class="header-row-search">
      <div class="app-title">
        <span>📸 云端相册</span>
        ${currentBaseUrl ? '<span class="status-badge" style="font-size: 0.72rem; background: rgba(16,185,129,0.15); color: #059669; padding: 2px 6px; border-radius: 4px; margin-left: 6px; font-weight: normal;" title="已启用自定义域名加速">CDN加速</span>' : ''}
      </div>
      <div class="search-wrapper">
        <span class="search-icon">🔍</span>
        <input id="search-input" type="search" placeholder="搜索照片名称、相册..." value="${esc(searchQuery)}">
      </div>
      <button id="btn-settings" class="icon-btn" title="系统设置" aria-label="设置">⚙️</button>
    </div>
  `;

  // 顶部第二行：视图标签、排序器及批量选择辅助
  const tabs = [
    ['timeline', '时间线'],
    ['albums', '相册'],
    ['trash', '回收站'],
    ['upload-logs', '上传日志']
  ].map(([id, label]) => `
    <button class="tab ${view === id ? 'active' : ''}" data-view="${id}">${label}</button>
  `).join('');

  const sortOptions = `
    <select id="sort-select" class="select-control" title="选择排序方式">
      <option value="date-desc" ${sortBy === 'date-desc' ? 'selected' : ''}>📅 日期 (最新优先)</option>
      <option value="date-asc" ${sortBy === 'date-asc' ? 'selected' : ''}>📅 日期 (最早优先)</option>
      <option value="size-desc" ${sortBy === 'size-desc' ? 'selected' : ''}>📦 大小 (从大到小)</option>
      <option value="size-asc" ${sortBy === 'size-asc' ? 'selected' : ''}>📦 大小 (从小到大)</option>
    </select>
  `;

  const topToolsRow = `
    <div class="header-row-tools">
      <nav class="nav-tabs">${tabs}</nav>
      <div class="tool-controls">
        ${sortOptions}
        <button id="btn-select-all" class="tool-btn">${selected.size === filteredPhotos.length && filteredPhotos.length > 0 ? '取消全选' : '全选'}</button>
        ${view === 'trash' ? '<button id="btn-empty-trash" class="tool-btn danger">清空回收站</button>' : ''}
      </div>
    </div>
  `;

  // 主内容区：相册侧边栏(仅相册视图且PC端显示) + 相册网格
  const showSidebar = view === 'albums';
  const sidebarHtml = showSidebar ? `
    <aside class="sidebar">
      <h3>我的相册</h3>
      <button class="album-nav-item ${currentAlbum === '全部' ? 'active' : ''}" data-album="全部">
        <span>全部照片</span>
        <span class="badge">${index.photos.filter(p => !p.trashed).length}</span>
      </button>
      <button class="album-nav-item ${currentAlbum === '未分类' ? 'active' : ''}" data-album="未分类">
        <span>未分类</span>
        <span class="badge">${index.photos.filter(p => !p.trashed && !p.album).length}</span>
      </button>
      ${(index.albums || []).map(albumName => {
        const count = index.photos.filter(p => !p.trashed && p.album === albumName).length;
        return `
          <button class="album-nav-item ${currentAlbum === albumName ? 'active' : ''}" data-album="${esc(albumName)}">
            <span>📁 ${esc(albumName)}</span>
            <div class="album-right">
              <span class="badge">${count}</span>
              <span class="btn-edit-album" data-edit-album="${esc(albumName)}" title="重命名相册">✏️</span>
              <span class="btn-delete-album" data-delete-album="${esc(albumName)}" title="删除相册">🗑️</span>
            </div>
          </button>
        `;
      }).join('')}
      <button id="btn-new-album" class="btn-new-album">＋ 新建相册</button>
    </aside>
  ` : '';

  // 底部固定操作条 (上传、移动、下载、删除)
  const isSelected = selected.size > 0;
  const bottomBarHtml = `
    <footer class="bottom-action-bar">
      <div class="bottom-bar-content">
        <div class="bottom-selection-info">
          <span>${isSelected ? `已选中 <b>${selected.size}</b> 项` : `共 <b>${filteredPhotos.length}</b> 项`}</span>
        </div>
        <div class="bottom-actions-group">
          ${view !== 'trash' ? '<button id="btn-bottom-upload" class="bottom-btn bottom-btn-upload">⬆️ 上传</button>' : ''}
          ${view !== 'trash' ? `<button id="btn-bottom-move-album" class="bottom-btn" ${isSelected ? '' : 'style="display:none;"'}>📁 移至相册</button>` : ''}
          <button id="btn-bottom-download" class="bottom-btn bottom-btn-download" ${isSelected ? '' : 'disabled'}>⬇️ 下载</button>
          <button id="btn-bottom-delete" class="bottom-btn bottom-btn-delete ${isSelected ? 'active-lit' : ''}" ${isSelected ? '' : 'disabled'}>🗑️ 删除</button>
        </div>
      </div>
    </footer>
  `;

  // 回到顶部按钮
  const backToTopHtml = `<button id="btn-back-to-top" aria-label="回到顶部" title="回到顶部">↑</button>`;

  app.innerHTML = `
    <header class="app-header">
      ${topSearchRow}
      ${topToolsRow}
    </header>
    <main class="content-wrapper">
      <div class="main-layout ${showSidebar ? '' : 'no-sidebar'}">
        ${sidebarHtml}
        <section id="gallery-container" class="gallery-section">
          <!-- 照片列表分批渲染容器 -->
          <div id="gallery-render-target"></div>
          <div id="loading-sentinel" class="loading-sentinel" style="display: none;">
            <div class="spinner"></div>
            <span>正在加载更多图片…</span>
          </div>
        </section>
      </div>
    </main>
    ${bottomBarHtml}
    ${backToTopHtml}
    <div id="toast" role="status" style="display: none;"></div>
  `;

  bindEvents();
  renderPhotosBatch(true);
}

/**
 * 分批渲染图片（按当前 visibleCount 切片渲染）
 * @param {boolean} reset 是否从头重置渲染
 */
function renderPhotosBatch(reset = false) {
  const target = document.querySelector('#gallery-render-target');
  const sentinel = document.querySelector('#loading-sentinel');
  if (!target) return;

  if (reset) {
    visibleCount = PAGE_SIZE;
    target.innerHTML = '';
  }

  const currentBatch = filteredPhotos.slice(0, visibleCount);

  if (filteredPhotos.length === 0) {
    target.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🖼️</div>
        <p>${searchQuery ? '没有找到匹配的照片' : '暂无照片，点击下方“上传”按钮开始添加吧！'}</p>
      </div>
    `;
    if (sentinel) sentinel.style.display = 'none';
    return;
  }

  // 根据当前视图与排序模式决定是否分组显示 (时间线模式且按日期倒序时分组)
  if (view === 'timeline' && sortBy === 'date-desc') {
    const grouped = currentBatch.reduce((groups, item) => {
      const day = format(item.takenAt || item.uploadedAt || new Date());
      (groups[day] ||= []).push(item);
      return groups;
    }, {});

    target.innerHTML = Object.entries(grouped).map(([day, photos]) => `
      <section class="day-group">
        <div class="group-header">
          <h2 class="group-title">${day}</h2>
          <span class="group-count">${photos.length} 张</span>
        </div>
        <div class="photo-grid">
          ${photos.map(p => renderPhotoCard(p)).join('')}
        </div>
      </section>
    `).join('');
  } else {
    // 平铺网格展示
    target.innerHTML = `
      <div class="photo-grid">
        ${currentBatch.map(p => renderPhotoCard(p)).join('')}
      </div>
    `;
  }

  // 是否显示加载指示器
  if (sentinel) {
    sentinel.style.display = visibleCount < filteredPhotos.length ? 'flex' : 'none';
  }

  // 绑定卡片交互并懒加载可视图片
  bindPhotoCardEvents();
  loadLazyThumbnails();
  setupInfiniteScroll();
}

/**
 * 渲染单张照片卡片 HTML
 * 如果配置了图片域名，直接赋 src 并设置 loading="lazy"，体验秒开且不用二次等待
 */
function renderPhotoCard(photo) {
  const isChecked = selected.has(photo.id);
  const publicUrl = getPublicImageUrl(photo.key);
  return `
    <article class="photo-card ${isChecked ? 'selected' : ''}" data-id="${photo.id}">
      <img data-key="${esc(photo.key)}" 
           ${publicUrl ? `src="${esc(publicUrl)}"` : ''} 
           alt="${esc(photo.name)}" 
           data-loaded="${publicUrl ? 'true' : 'false'}" 
           loading="lazy">
      <div class="check-indicator" data-check-id="${photo.id}" title="多选勾选">✓</div>
      <div class="photo-info-bar">
        <span class="photo-title" title="${esc(photo.name)}">${esc(photo.name)}</span>
        <span class="photo-meta">${formatSize(Number(photo.size))}</span>
      </div>
    </article>
  `;
}

/**
 * 懒加载缩略图
 * 优先使用自定义图片域名直链，如未配置或加载失败则回退到 R2 SDK 获取 Blob
 */
async function loadLazyThumbnails() {
  const images = document.querySelectorAll('img[data-key]');
  for (const img of images) {
    const key = img.dataset.key;
    if (!key) continue;

    const publicUrl = getPublicImageUrl(key);

    if (publicUrl) {
      // 已经设置并成功加载了直链则跳过
      if (img.dataset.loaded === 'true' && img.src === publicUrl) continue;

      img.onerror = async () => {
        img.onerror = null;
        try {
          const response = await r2.get(key);
          const blob = await response.blob();
          img.src = URL.createObjectURL(blob);
          img.dataset.loaded = 'true';
        } catch (err) {
          img.alt = '加载失败';
        }
      };
      img.onload = () => {
        img.dataset.loaded = 'true';
      };
      img.src = publicUrl;
      continue;
    }

    // 未配置图片域名时，走 R2 SDK 签名拉取
    if (img.dataset.loaded === 'true') continue;
    try {
      const cached = getCachedImageUrl(key);
      if (cached) {
        img.src = cached;
        img.dataset.loaded = 'true';
        continue;
      }
      const response = await r2.get(key);
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      setCachedImageUrl(key, blobUrl, true);
      img.src = blobUrl;
      img.dataset.loaded = 'true';
    } catch (err) {
      img.alt = '加载失败';
    }
  }
}

/**
 * 配置无限滚动交叉监听器 IntersectionObserver
 */
function setupInfiniteScroll() {
  const sentinel = document.querySelector('#loading-sentinel');
  if (!sentinel) return;

  if (intersectionObserver) {
    intersectionObserver.disconnect();
  }

  intersectionObserver = new IntersectionObserver((entries) => {
    const first = entries[0];
    if (first && first.isIntersecting && visibleCount < filteredPhotos.length) {
      visibleCount += PAGE_SIZE;
      renderPhotosBatch(false);
    }
  }, {
    rootMargin: '200px'
  });

  intersectionObserver.observe(sentinel);
}

/**
 * 绑定全局和页面顶底交互事件
 */
function bindEvents() {
  // 搜索输入监听 (防抖处理)
  const searchInput = document.querySelector('#search-input');
  if (searchInput) {
    let timeout;
    searchInput.oninput = (e) => {
      clearTimeout(timeout);
      timeout = setTimeout(() => {
        searchQuery = e.target.value;
        updateFilteredPhotos();
        renderPhotosBatch(true);
        updateBottomBarState();
      }, 250);
    };
  }

  // 设置入口
  const settingsBtn = document.querySelector('#btn-settings');
  if (settingsBtn) settingsBtn.onclick = () => renderSettings();

  // 排序下拉框
  const sortSelect = document.querySelector('#sort-select');
  if (sortSelect) {
    sortSelect.onchange = (e) => {
      sortBy = e.target.value;
      updateFilteredPhotos();
      renderPhotosBatch(true);
    };
  }

  // 视图标签切换
  document.querySelectorAll('.nav-tabs .tab').forEach(tab => {
    tab.onclick = () => {
      const targetView = tab.dataset.view;
      if (targetView === 'upload-logs') {
        renderUploadLogs();
        return;
      }
      view = targetView;
      selected.clear();
      renderApp();
    };
  });

  // 全选/取消全选
  const selectAllBtn = document.querySelector('#btn-select-all');
  if (selectAllBtn) {
    selectAllBtn.onclick = () => {
      if (selected.size === filteredPhotos.length && filteredPhotos.length > 0) {
        selected.clear();
      } else {
        filteredPhotos.forEach(p => selected.add(p.id));
      }
      updateSelectionVisuals();
    };
  }

  // 清空回收站
  const emptyTrashBtn = document.querySelector('#btn-empty-trash');
  if (emptyTrashBtn) {
    emptyTrashBtn.onclick = async () => {
      if (!confirm('确定彻底删除回收站中的所有照片？此操作无法撤销。')) return;
      for (const p of index.photos.filter(p => p.trashed)) {
        await r2.delete(p.key).catch(() => {});
      }
      index.photos = index.photos.filter(p => !p.trashed);
      selected.clear();
      await save();
      renderApp();
    };
  }

  // 相册侧边栏切换
  document.querySelectorAll('.album-nav-item[data-album]').forEach(btn => {
    btn.onclick = (e) => {
      // 如果点击的是删除或重命名相册按钮，则不触发相册切换
      if (e.target.closest('[data-delete-album]') || e.target.closest('[data-edit-album]')) return;
      currentAlbum = btn.dataset.album;
      selected.clear();
      renderApp();
    };
  });

  // 重命名相册
  document.querySelectorAll('[data-edit-album]').forEach(btn => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      const oldName = btn.dataset.editAlbum;
      if (!oldName) return;

      const newName = prompt(`请输入相册「${oldName}」的新名称：`, oldName);
      if (!newName) return;
      const trimmed = newName.trim();
      if (!trimmed || trimmed === oldName) return;

      if ((index.albums || []).includes(trimmed)) {
        alert(`已存在名为「${trimmed}」的相册，请更换名称`);
        return;
      }

      try {
        // 更新相册列表
        index.albums = (index.albums || []).map(a => a === oldName ? trimmed : a);

        // 批量更新属于该相册的照片
        index.photos.forEach(p => {
          if (p.album === oldName) {
            p.album = trimmed;
          }
        });

        // 若当前选中的正是该相册，保持选中更新后的相册
        if (currentAlbum === oldName) {
          currentAlbum = trimmed;
        }

        await save();
        renderApp();
        toast(`相册「${oldName}」已成功重命名为「${trimmed}」`);
      } catch (err) {
        console.error('重命名相册失败:', err);
        alert(`重命名相册失败: ${err.message}`);
      }
    };
  });

  // 删除相册
  document.querySelectorAll('[data-delete-album]').forEach(btn => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      const albumToDelete = btn.dataset.deleteAlbum;
      if (!albumToDelete) return;

      const count = index.photos.filter(p => !p.trashed && p.album === albumToDelete).length;
      const confirmMsg = count > 0
        ? `确定要删除相册「${albumToDelete}」吗？\n该相册内共有 ${count} 张照片，删除后照片将变为「未分类」（不会删除照片本身）。`
        : `确定要删除相册「${albumToDelete}」吗？`;

      if (!confirm(confirmMsg)) return;

      try {
        // 从相册列表中移除
        index.albums = (index.albums || []).filter(a => a !== albumToDelete);

        // 将该相册下的所有照片设置为未分类 (album = null)
        index.photos.forEach(p => {
          if (p.album === albumToDelete) {
            delete p.album;
          }
        });

        // 如果当前选中的正是被删除的相册，重置为全部或未分类
        if (currentAlbum === albumToDelete) {
          currentAlbum = '全部';
        }

        // 保存索引并刷新
        await save();
        renderApp();
      } catch (err) {
        console.error('删除相册失败:', err);
        alert('删除相册失败，请重试');
      }
    };
  });

  // 新建相册
  const newAlbumBtn = document.querySelector('#btn-new-album');
  if (newAlbumBtn) {
    newAlbumBtn.onclick = async () => {
      const name = prompt('请输入新相册名称:');
      if (name && name.trim()) {
        const trimmed = name.trim();
        index.albums = index.albums || [];
        if (!index.albums.includes(trimmed)) {
          index.albums.push(trimmed);
          await save();
          currentAlbum = trimmed;
          renderApp();
        }
      }
    };
  }

  // 底部上传按钮
  const bottomUploadBtn = document.querySelector('#btn-bottom-upload');
  if (bottomUploadBtn) {
    bottomUploadBtn.onclick = () => input.click();
  }

  // 底部移动相册按钮
  const bottomMoveBtn = document.querySelector('#btn-bottom-move-album');
  if (bottomMoveBtn) {
    bottomMoveBtn.onclick = () => openMoveAlbumDialog([...selected]);
  }

  // 底部下载按钮
  const bottomDownloadBtn = document.querySelector('#btn-bottom-download');
  if (bottomDownloadBtn) {
    bottomDownloadBtn.onclick = () => batchDownload();
  }

  // 底部删除按钮
  const bottomDeleteBtn = document.querySelector('#btn-bottom-delete');
  if (deleteBtn => deleteBtn) {
    if (bottomDeleteBtn) bottomDeleteBtn.onclick = () => batchDelete();
  }

  // 回到顶部按钮逻辑与滚动监听
  const backToTopBtn = document.querySelector('#btn-back-to-top');
  if (backToTopBtn) {
    window.onscroll = () => {
      if (window.scrollY > 300) {
        backToTopBtn.classList.add('visible');
      } else {
        backToTopBtn.classList.remove('visible');
      }
    };

    backToTopBtn.onclick = () => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    };
  }

  // 拖拽上传支持
  const dropzone = document.querySelector('.content-wrapper');
  if (dropzone) {
    dropzone.ondragover = (e) => e.preventDefault();
    dropzone.ondrop = (e) => {
      e.preventDefault();
      if (e.dataTransfer && e.dataTransfer.files.length) {
        upload([...e.dataTransfer.files]);
      }
    };
  }
}

/**
 * 绑定单张照片卡片交互事件（点击卡片预览 / 点击勾选框切换多选）
 */
function bindPhotoCardEvents() {
  document.querySelectorAll('.photo-card').forEach(card => {
    const photoId = card.dataset.id;
    const photo = filteredPhotos.find(p => p.id === photoId);
    if (!photo) return;

    // 点击左上角多选框
    const checkBtn = card.querySelector('.check-indicator');
    if (checkBtn) {
      checkBtn.onclick = (e) => {
        e.stopPropagation();
        toggleSelect(photoId);
      };
    }

    // 点击卡片整体：若已有选中项则切换勾选，否则打开图片查看器
    card.onclick = () => {
      if (selected.size > 0) {
        toggleSelect(photoId);
      } else {
        openViewer(photo, filteredPhotos);
      }
    };
  });
}

/**
 * 切换单项选中状态
 */
function toggleSelect(id) {
  if (selected.has(id)) {
    selected.delete(id);
  } else {
    selected.add(id);
  }
  updateSelectionVisuals();
}

/**
 * 更新选中态视觉表现与底部操作栏点亮状态
 */
function updateSelectionVisuals() {
  // 更新照片卡片样式
  document.querySelectorAll('.photo-card').forEach(card => {
    const id = card.dataset.id;
    card.classList.toggle('selected', selected.has(id));
  });

  // 更新全选按钮文字
  const selectAllBtn = document.querySelector('#btn-select-all');
  if (selectAllBtn) {
    selectAllBtn.textContent = (selected.size === filteredPhotos.length && filteredPhotos.length > 0) ? '取消全选' : '全选';
  }

  // 更新底部信息和按钮状态
  updateBottomBarState();
}

/**
 * 动态刷新底部操作栏状态
 */
function updateBottomBarState() {
  const isSelected = selected.size > 0;
  
  // 更新选中计数
  const infoSpan = document.querySelector('.bottom-selection-info');
  if (infoSpan) {
    infoSpan.innerHTML = `<span>${isSelected ? `已选中 <b>${selected.size}</b> 项` : `共 <b>${filteredPhotos.length}</b> 项`}</span>`;
  }

  // 更新移动相册按钮（若存在）
  const moveBtn = document.querySelector('#btn-bottom-move-album');
  if (moveBtn) {
    moveBtn.disabled = !isSelected;
    moveBtn.style.display = isSelected ? 'inline-flex' : 'none';
  }

  // 更新下载按钮
  const downloadBtn = document.querySelector('#btn-bottom-download');
  if (downloadBtn) downloadBtn.disabled = !isSelected;

  // 更新删除按钮（点亮/置灰）
  const deleteBtn = document.querySelector('#btn-bottom-delete');
  if (deleteBtn) {
    deleteBtn.disabled = !isSelected;
    deleteBtn.classList.toggle('active-lit', isSelected);
  }
}

/**
 * 纯原生微型 Zip 打包生成器（零外部依赖，避免批量下载被浏览器判定为多文件弹窗拦截）
 */
function createZipBlob(files) {
  // files: Array<{ name: string, data: Uint8Array }>
  const fileRecords = [];
  let offset = 0;

  // CRC-32 查找表与计算
  const crcTable = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    crcTable[i] = c;
  }
  const calcCRC32 = (buf) => {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) {
      crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xFF];
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  };

  const textEncoder = new TextEncoder();
  const chunks = [];

  for (const file of files) {
    const filenameBytes = textEncoder.encode(file.name);
    const dataBytes = file.data;
    const crc = calcCRC32(dataBytes);
    const size = dataBytes.length;

    // Local file header (30 bytes + name length)
    const localHeader = new Uint8Array(30 + filenameBytes.length);
    const view = new DataView(localHeader.buffer);
    view.setUint32(0, 0x04034b50, true); // Local file header signature
    view.setUint16(4, 10, true);         // Version needed
    view.setUint16(6, 0x0800, true);     // General purpose bit flag (UTF-8)
    view.setUint16(8, 0, true);          // Compression method (0 = Store)
    view.setUint16(10, 0, true);         // Mod time
    view.setUint16(12, 0, true);         // Mod date
    view.setUint32(14, crc, true);       // CRC-32
    view.setUint32(18, size, true);      // Compressed size
    view.setUint32(22, size, true);      // Uncompressed size
    view.setUint16(26, filenameBytes.length, true); // File name length
    view.setUint16(28, 0, true);         // Extra field length
    localHeader.set(filenameBytes, 30);

    chunks.push(localHeader);
    chunks.push(dataBytes);

    fileRecords.push({
      nameBytes: filenameBytes,
      size,
      crc,
      offset
    });

    offset += localHeader.length + dataBytes.length;
  }

  const centralDirStart = offset;
  let centralDirSize = 0;

  // Central directory records
  for (const rec of fileRecords) {
    const cdRecord = new Uint8Array(46 + rec.nameBytes.length);
    const view = new DataView(cdRecord.buffer);
    view.setUint32(0, 0x02014b50, true); // Central file header signature
    view.setUint16(4, 20, true);         // Version made by
    view.setUint16(6, 10, true);         // Version needed
    view.setUint16(8, 0x0800, true);     // Flags (UTF-8)
    view.setUint16(10, 0, true);        // Compression (Store)
    view.setUint16(12, 0, true);        // Mod time
    view.setUint16(14, 0, true);        // Mod date
    view.setUint32(16, rec.crc, true);  // CRC-32
    view.setUint32(20, rec.size, true); // Compressed size
    view.setUint32(24, rec.size, true); // Uncompressed size
    view.setUint16(28, rec.nameBytes.length, true); // File name length
    view.setUint16(30, 0, true);        // Extra field length
    view.setUint16(32, 0, true);        // File comment length
    view.setUint16(34, 0, true);        // Disk number start
    view.setUint16(36, 0, true);        // Internal file attributes
    view.setUint32(38, 0, true);        // External file attributes
    view.setUint32(42, rec.offset, true);// Relative offset of local header
    cdRecord.set(rec.nameBytes, 46);

    chunks.push(cdRecord);
    centralDirSize += cdRecord.length;
  }

  // End of central directory record (22 bytes)
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true); // EOCD signature
  eocdView.setUint16(4, 0, true);          // Disk number
  eocdView.setUint16(6, 0, true);          // Disk with CD
  eocdView.setUint16(8, fileRecords.length, true);  // Disk entries
  eocdView.setUint16(10, fileRecords.length, true); // Total entries
  eocdView.setUint32(12, centralDirSize, true);    // Central dir size
  eocdView.setUint32(16, centralDirStart, true);   // Central dir offset
  eocdView.setUint16(20, 0, true);         // Comment length

  chunks.push(eocd);

  return new Blob(chunks, { type: 'application/zip' });
}

/**
 * 批量下载选中的图片（单张直接下载，多张在前端零依赖打包为 .zip 单文件下载，彻底解决浏览器拦截）
 */
async function batchDownload() {
  if (!selected.size) return;
  const photos = filteredPhotos.filter(p => selected.has(p.id));
  
  if (photos.length === 1) {
    await download(photos[0]);
    return;
  }

  toast(`正在打包下载 ${photos.length} 张照片…`);
  try {
    const fileEntries = [];
    const usedNames = new Map();

    for (let i = 0; i < photos.length; i++) {
      const p = photos[i];
      const res = await r2.get(p.key);
      const ab = await res.arrayBuffer();
      
      // 文件名防重名处理
      let filename = p.name || `photo_${i + 1}.jpg`;
      if (usedNames.has(filename)) {
        const count = usedNames.get(filename) + 1;
        usedNames.set(filename, count);
        const extIdx = filename.lastIndexOf('.');
        if (extIdx > 0) {
          filename = `${filename.slice(0, extIdx)} (${count})${filename.slice(extIdx)}`;
        } else {
          filename = `${filename} (${count})`;
        }
      } else {
        usedNames.set(filename, 0);
      }

      fileEntries.push({
        name: filename,
        data: new Uint8Array(ab)
      });
    }

    const zipBlob = createZipBlob(fileEntries);
    const dateStr = new Date().toISOString().slice(0, 10);
    const zipName = `photos_${dateStr}_${photos.length}files.zip`;

    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(zipBlob),
      download: zipName
    });
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1000);

    toast(`已成功打包并开始下载「${zipName}」🎉`);
  } catch (err) {
    console.error('批量下载失败:', err);
    toast(`批量下载失败：${err.message}`, true);
  }
}

/**
 * 批量删除（移入回收站或彻底删除）
 */
async function batchDelete() {
  if (!selected.size) return;
  const photos = index.photos.filter(p => selected.has(p.id));
  
  if (view === 'trash') {
    if (!confirm(`确定彻底删除选中的 ${photos.length} 张照片？`)) return;
    for (const p of photos) {
      await r2.delete(p.key).catch(() => {});
    }
    index.photos = index.photos.filter(p => !selected.has(p.id));
  } else {
    if (!confirm(`将选中的 ${photos.length} 张照片移入回收站？`)) return;
    for (const p of photos) {
      const trashKey = p.key.replace(/^photos\//, 'trash/');
      await r2.copy(p.key, trashKey);
      await r2.delete(p.key);
      p.key = trashKey;
      p.trashed = true;
      p.deletedAt = new Date().toISOString();
    }
  }

  selected.clear();
  await save();
  renderApp();
  toast('删除操作完成');
}

/**
 * 移动图片到相册弹窗对话框（支持单张与批量移动、新建相册、移至未分类）
 */
function openMoveAlbumDialog(photoIds, onSuccess) {
  if (!photoIds || !photoIds.length) return;
  const count = photoIds.length;
  const albums = index.albums || [];

  const modalHtml = `
    <div id="move-album-modal" class="modal-overlay" role="dialog" aria-modal="true">
      <div class="modal-dialog">
        <div class="modal-header">
          <h3>📁 移动 ${count} 张照片到相册</h3>
          <button class="modal-close" aria-label="关闭">×</button>
        </div>
        <p style="margin: 6px 0 10px; font-size: 0.85rem; color: var(--muted);">请选择目标相册或新建相册：</p>
        <div class="move-album-list">
          <div class="move-album-option" data-target-album="">
            <span>📄 移出相册 (设为未分类)</span>
          </div>
          ${albums.map(a => `
            <div class="move-album-option" data-target-album="${esc(a)}">
              <span>📁 ${esc(a)}</span>
              <span class="badge" style="font-size:0.75rem; color:var(--muted);">${index.photos.filter(p => !p.trashed && p.album === a).length} 张</span>
            </div>
          `).join('')}
        </div>
        <div class="move-album-create">
          <input id="modal-new-album-input" type="text" placeholder="或者输入新建相册名..." />
          <button id="modal-create-and-move" class="btn" style="white-space:nowrap; background:var(--brand); color:#fff;">新建并移动</button>
        </div>
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML('beforeend', modalHtml);
  const modal = document.querySelector('#move-album-modal');

  const closeModal = () => modal.remove();
  modal.querySelector('.modal-close').onclick = closeModal;
  modal.onclick = (e) => {
    if (e.target === modal) closeModal();
  };

  const applyMove = async (targetAlbumName) => {
    closeModal();
    const photos = index.photos.filter(p => photoIds.includes(p.id));
    photos.forEach(p => {
      if (targetAlbumName) {
        p.album = targetAlbumName;
      } else {
        delete p.album;
      }
    });

    selected.clear();
    await save();
    renderApp();
    const label = targetAlbumName ? `相册「${targetAlbumName}」` : '「未分类」';
    toast(`已将 ${count} 张照片移动至 ${label}`);
    if (onSuccess) onSuccess(targetAlbumName);
  };

  // 点击选择已有相册或未分类
  modal.querySelectorAll('.move-album-option').forEach(opt => {
    opt.onclick = () => {
      const target = opt.dataset.targetAlbum;
      applyMove(target);
    };
  });

  // 新建相册并移动
  const newAlbumInput = modal.querySelector('#modal-new-album-input');
  const createBtn = modal.querySelector('#modal-create-and-move');
  const handleCreateMove = () => {
    const name = newAlbumInput.value.trim();
    if (!name) return;
    index.albums = index.albums || [];
    if (!index.albums.includes(name)) {
      index.albums.push(name);
    }
    applyMove(name);
  };

  createBtn.onclick = handleCreateMove;
  newAlbumInput.onkeydown = (e) => {
    if (e.key === 'Enter') handleCreateMove();
  };
}

/**
 * 批量移动到相册
 */
async function batchMoveAlbum() {
  if (!selected.size) return;
  openMoveAlbumDialog([...selected]);
}

/**
 * 文件上传逻辑
 */
input.onchange = () => upload([...input.files]);

async function upload(files) {
  if (!files || !files.length) return;
  const validFiles = files.filter(f => f.type.startsWith('image/'));
  if (!validFiles.length) {
    toast('请选择图片格式的文件进行上传', true);
    return;
  }

  const lock = navigator.wakeLock && await navigator.wakeLock.request('screen').catch(() => null);

  for (const file of validFiles) {
    const startedAt = new Date().toISOString();
    const logId = createUploadLog({ fileName: file.name, fileSize: file.size, startedAt });
    const date = new Date();
    const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
    const key = `photos/${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}/${uuid()}.${ext}`;
    
    let uploaded = false;
    let logStatus = 'success';
    let logError = '';

    try {
      toast(`正在上传 ${file.name}…`);
      await r2.put(key, file, (done, total) => {
        toast(`正在上传 ${file.name} ${Math.round((done / total) * 100)}%`);
      });
      uploaded = true;

      const dimensions = await imageDimensions(file);
      index.photos.unshift({
        id: uuid(),
        key,
        name: file.name,
        size: file.size,
        takenAt: date.toISOString(),
        uploadedAt: date.toISOString(),
        album: (view === 'albums' && currentAlbum !== '全部' && currentAlbum !== '未分类') ? currentAlbum : '',
        tags: [],
        dimensions,
        trashed: false
      });
      await save();
    } catch (error) {
      const message = error?.message || String(error);
      logStatus = 'failed';
      logError = uploaded ? `文件已上传到 R2，但索引更新失败：${message}` : message;
      toast(`${file.name} 上传失败：${message}`, true);
    } finally {
      finishUploadLog(logId, {
        status: logStatus,
        r2Key: uploaded ? key : '',
        error: logStatus === 'failed' ? logError : '',
        finishedAt: new Date().toISOString()
      });
    }
  }

  lock?.release();
  input.value = '';
  renderApp();
  toast('上传流程已完成');
}

/**
 * 保存相册元索引
 */
async function save() {
  await saveIndex(r2, index);
}

/**
 * 单张下载
 */
async function download(photo) {
  try {
    const response = await r2.get(photo.key);
    const blob = await response.blob();
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(blob),
      download: photo.name
    });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } catch (err) {
    toast(`下载失败：${err.message}`, true);
  }
}

/**
 * 设置页视图
 */
function renderSettings() {
  const currentBaseUrl = config.getImgBaseUrl();
  const sampleKey = index.photos && index.photos[0] ? index.photos[0].key : 'photos/2026/08/sample.jpg';
  const sampleUrl = currentBaseUrl ? `${currentBaseUrl}/${sampleKey}` : '';

  app.innerHTML = `
    <section class="setup">
      <h1>⚙️ 相册设置</h1>
      <p>Cloudflare R2 存储凭据及图片域名仅安全保存在当前浏览器的 localStorage 中。</p>
      
      <!-- 图片域名 Base URL 配置卡片 -->
      <div style="margin: 20px 0; padding: 18px; background: var(--bg); border-radius: 12px; border: 1px solid var(--line);">
        <h3 style="margin-top: 0; font-size: 1.05rem; display: flex; align-items: center; justify-content: space-between;">
          <span>🌐 自定义图片域名 (Base URL)</span>
          <span style="font-size: 0.8rem; font-weight: normal; padding: 2px 8px; border-radius: 6px; background: ${currentBaseUrl ? 'rgba(16, 185, 129, 0.15); color: #059669;' : 'var(--line); color: var(--muted);'}">
            ${currentBaseUrl ? '✅ 已生效 (直链加速)' : '未配置 (私有拉取)'}
          </span>
        </h3>
        <p style="font-size: 0.85rem; color: var(--muted); margin-bottom: 12px; line-height: 1.5;">
          输入绑定至 R2 的自定义域名或公共访问域名（例如 <code>https://cdn.example.com</code> 或 <code>https://pub-xxx.r2.dev</code>）。配置后图片卡片将直接通过 CDN 加载，并提供直链复制和分享。
        </p>

        <form id="form-img-base-url" style="display: flex; flex-direction: column; gap: 8px;">
          <input id="input-img-base-url" 
                 type="url" 
                 placeholder="例如：https://cdn.example.com" 
                 value="${esc(currentBaseUrl)}"
                 style="width: 100%; padding: 10px; border: 1px solid var(--line); border-radius: 8px; font-size: 0.95rem;">
          
          <div id="url-preview-box" style="font-size: 0.8rem; color: var(--muted); word-break: break-all; margin-top: 2px;">
            ${sampleUrl ? `预览直链：<a href="${esc(sampleUrl)}" target="_blank" style="color: var(--brand); text-decoration: underline;">${esc(sampleUrl)}</a>` : '填写后可在下方预览单张照片直链'}
          </div>

          <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 10px;">
            <button type="submit" class="primary" style="width: 100%; padding: 10px 12px; font-size: 0.9rem;">💾 保存并应用到相册</button>
            ${currentBaseUrl ? `
              <div style="text-align: center;">
                <button type="button" id="btn-clear-img-base" style="background: none; border: none; color: var(--danger, #ef4444); font-size: 0.82rem; cursor: pointer; text-decoration: underline; padding: 4px 8px;">清除自定义域名</button>
              </div>
            ` : ''}
          </div>
        </form>
      </div>

      <!-- 应用版本与更新卡片 -->
      <div style="margin: 20px 0; padding: 18px; background: var(--bg); border-radius: 12px; border: 1px solid var(--line);">
        <h3 style="margin-top: 0; font-size: 1.05rem; display: flex; align-items: center; justify-content: space-between;">
          <span>🚀 应用版本与更新</span>
          <span id="app-ver-badge" style="font-size: 0.8rem; font-weight: normal; padding: 2px 8px; border-radius: 6px; background: rgba(37, 99, 235, 0.12); color: var(--brand);">
            ${APP_VERSION}
          </span>
        </h3>
        <p style="font-size: 0.85rem; color: var(--muted); margin-bottom: 14px; line-height: 1.5;">
          离线缓存已开启。当远端更新 UI 或功能时，可点击下方按钮即时检查并同步最新版本。
          <span id="update-status-detail" style="display: block; margin-top: 4px; font-size: 0.82rem; color: var(--brand);"></span>
        </p>
        <div style="display: flex; gap: 10px; flex-wrap: wrap;">
          <button type="button" id="btn-check-update" class="primary" style="flex: 1; min-width: 130px; padding: 10px 12px; font-size: 0.9rem;">🔍 检查更新</button>
          <button type="button" id="btn-force-reload" style="flex: 1; min-width: 130px; padding: 10px 12px; font-size: 0.9rem; background: var(--card-bg, #f1f5f9); border: 1px solid var(--line); color: var(--text);">🔄 清除缓存并刷新</button>
        </div>
      </div>

      <div style="display: flex; flex-direction: column; gap: 10px; margin-top: 20px;">
        <button id="btn-edit-credentials" class="primary">修改 R2 凭据</button>
        <button id="btn-clear-credentials" class="danger">清除本机凭据</button>
        <button id="btn-back-home">返回相册</button>
      </div>
    </section>
  `;

  // 动态输入时更新预览
  const inputBase = document.querySelector('#input-img-base-url');
  const previewBox = document.querySelector('#url-preview-box');
  if (inputBase && previewBox) {
    inputBase.oninput = () => {
      const val = inputBase.value.trim().replace(/\/+$/, '');
      if (val) {
        const testUrl = `${val}/${sampleKey}`;
        previewBox.innerHTML = `预览直链：<a href="${esc(testUrl)}" target="_blank" style="color: var(--brand); text-decoration: underline;">${esc(testUrl)}</a>`;
      } else {
        previewBox.textContent = '留空则使用 R2 私有直连拉取 Blob。';
      }
    };
  }

  // 保存图片域名并直接刷新主相册
  document.querySelector('#form-img-base-url').onsubmit = (e) => {
    e.preventDefault();
    const val = inputBase.value.trim();
    config.setImgBaseUrl(val);
    toast(val ? '已保存图片域名，正在刷新相册…' : '已清除图片域名');
    setTimeout(() => {
      renderApp();
    }, 400);
  };

  const clearImgBaseBtn = document.querySelector('#btn-clear-img-base');
  if (clearImgBaseBtn) {
    clearImgBaseBtn.onclick = () => {
      if (confirm('确定清除图片外链域名？清除后相册将回退为 R2 SDK 私有加载。')) {
        config.clearImgBaseUrl();
        toast('已清除图片域名，正在刷新相册…');
        setTimeout(() => {
          renderApp();
        }, 400);
      }
    };
  }

  document.querySelector('#btn-edit-credentials').onclick = () => renderSetup(config.get());
  document.querySelector('#btn-clear-credentials').onclick = () => {
    if (confirm('确定清除本机保存的 R2 凭据？')) {
      config.clear();
      renderSetup();
    }
  };
  document.querySelector('#btn-back-home').onclick = () => renderApp();
}

/**
 * 显示测试连接失败弹窗与排查指南
 * @param {Error|object} error 捕获到的错误对象
 * @param {object} inputValues 用户在表单填写的凭据（用于检查空格或格式）
 */
function showConnectionErrorModal(error, inputValues = {}) {
  // 先移除可能存在的旧弹窗
  const oldModal = document.querySelector('#connection-error-modal');
  if (oldModal) oldModal.remove();

  const errorMessage = error?.message || String(error || '未知错误');
  const errorStack = error?.stack || '无调用栈信息';

  // 凭据格式检查（是否有前后空格等常见问题）
  const spaceWarnings = [];
  if (inputValues.accountId && inputValues.accountId !== inputValues.accountId.trim()) {
    spaceWarnings.push('Account ID 包含首尾多余空格');
  }
  if (inputValues.accessKeyId && inputValues.accessKeyId !== inputValues.accessKeyId.trim()) {
    spaceWarnings.push('Access Key ID 包含首尾多余空格');
  }
  if (inputValues.secretAccessKey && inputValues.secretAccessKey !== inputValues.secretAccessKey.trim()) {
    spaceWarnings.push('Secret Access Key 包含首尾多余空格');
  }
  if (inputValues.bucket && inputValues.bucket !== inputValues.bucket.trim()) {
    spaceWarnings.push('Bucket 名称包含首尾多余空格');
  }

  // 整理供用户一键复制的完整错误诊断文本
  const copyDetails = [
    `=== 云端相册连接测试诊断报告 ===`,
    `时间: ${new Date().toLocaleString()}`,
    `当前网址 (Origin): ${window.location.origin}`,
    `存储桶 (Bucket): ${inputValues.bucket || '未填'}`,
    `Account ID: ${inputValues.accountId ? inputValues.accountId.substring(0, 6) + '***' : '未填'}`,
    `Access Key ID: ${inputValues.accessKeyId ? inputValues.accessKeyId.substring(0, 6) + '***' : '未填'}`,
    `错误简述: ${errorMessage}`,
    spaceWarnings.length ? `格式预警: ${spaceWarnings.join('；')}` : null,
    `\n--- 详细错误信息 ---`,
    errorStack
  ].filter(Boolean).join('\n');

  const modalHtml = `
    <div id="connection-error-modal" class="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="modal-error-title">
      <div class="modal-dialog">
        <div class="modal-header">
          <div class="modal-title" id="modal-error-title">
            <span>⚠️</span>
            <span>连接测试失败</span>
          </div>
          <button type="button" class="modal-close-icon" id="btn-modal-x" title="关闭" aria-label="关闭">✕</button>
        </div>
        <div class="modal-body">
          <div class="error-summary-box">
            ${esc(errorMessage)}
          </div>

          ${spaceWarnings.length ? `
            <div class="error-summary-box" style="background: rgba(245, 158, 11, 0.1); border-color: rgba(245, 158, 11, 0.3); color: #d97706;">
              ⚠️ <strong>输入格式注意：</strong>${esc(spaceWarnings.join('，'))}，请仔细检查复制粘贴时是否多选了空格。
            </div>
          ` : ''}

          <div class="troubleshoot-guide">
            <h4>💡 常见原因与排查指南</h4>
            <ol class="troubleshoot-list">
              <li>
                <strong>CORS 跨域策略未配置或域名不匹配</strong>
                <p>在 Cloudflare R2 存储桶设置中的 <strong>CORS 策略</strong> 必须允许当前网页源 <code class="troubleshoot-code">${esc(window.location.origin)}</code>，且包含 <code class="troubleshoot-code">GET, PUT, DELETE, HEAD</code> 请求方法。</p>
              </li>
              <li>
                <strong>R2 API 令牌权限不足</strong>
                <p>创建 API 令牌时必须选择 <strong>对象读和写 (Object Read & Write)</strong> 权限，并且该令牌必须授权访问当前填写的存储桶。</p>
              </li>
              <li>
                <strong>凭据拼写与多余空格</strong>
                <p>请确保 <strong>Account ID</strong>（通常为32位十六进制字符串）、<strong>Access Key ID</strong> 与 <strong>Secret Access Key</strong> 完整正确，检查首尾无空格或换行符。</p>
              </li>
              <li>
                <strong>客户端 IP 白名单限制</strong>
                <p>如果在 Cloudflare 创建 API 令牌时启用了 <strong>客户端 IP 过滤 (Client IP Address Filtering)</strong>，请确保当前网络 IP 已在允许范围内，或暂时移除 IP 限制。</p>
              </li>
              <li>
                <strong>系统时钟偏差过大</strong>
                <p>AWS S3 / SigV4 协议对请求时间有效性有严格要求（通常不超过15分钟），若本机系统时区或系统时间不准确，会导致签名校验失败。</p>
              </li>
            </ol>
          </div>

          <details class="error-details-collapsible">
            <summary>查看详细错误信息 (Stack Trace)</summary>
            <pre>${esc(errorStack)}</pre>
          </details>
        </div>
        <div class="modal-footer">
          <button type="button" class="modal-btn modal-btn-copy" id="btn-modal-copy">📋 复制错误详情</button>
          <button type="button" class="modal-btn modal-btn-close" id="btn-modal-confirm">我知道了</button>
        </div>
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML('beforeend', modalHtml);

  const modal = document.querySelector('#connection-error-modal');
  const closeModal = () => {
    modal.remove();
    document.removeEventListener('keydown', escListener);
  };

  const escListener = (e) => {
    if (e.key === 'Escape') closeModal();
  };
  document.addEventListener('keydown', escListener);

  // 点击遮罩外部关闭
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });

  // 点击关闭按钮与确认按钮
  document.querySelector('#btn-modal-x').onclick = closeModal;
  document.querySelector('#btn-modal-confirm').onclick = closeModal;

  // 复制错误详情
  const copyBtn = document.querySelector('#btn-modal-copy');
  copyBtn.onclick = async () => {
    const success = await copyToClipboard(copyDetails);
    if (success) {
      copyBtn.textContent = '✅ 已复制到剪贴板';
      toast('错误详情已复制');
      setTimeout(() => {
        if (copyBtn) copyBtn.textContent = '📋 复制错误详情';
      }, 2000);
    } else {
      toast('复制失败，请手动选择复制', true);
    }
  };
}

/**
 * 初始化配置与凭据设置表单
 */
function renderSetup(saved = {}) {
  const currentBaseUrl = config.getImgBaseUrl();
  app.innerHTML = `
    <section class="setup">
      <div class="logo">📸</div>
      <h1>云端相册配置</h1>
      <p>照片直接保存到您自己的 Cloudflare R2 存储桶。凭据仅保存在此设备浏览器中，不会上传至任何第三方服务器。</p>
      <ol style="margin-left: 20px; margin-bottom: 16px; color: var(--muted); line-height: 1.8;">
        <li>登录 Cloudflare 控制台并创建 R2 存储桶</li>
        <li>创建拥有对象读写权限的 R2 API 令牌</li>
        <li>填写下面的凭据并测试连接</li>
      </ol>
      <form id="setup-form">
        <label>Account ID<input required name="accountId" value="${esc(saved.accountId)}"></label>
        <label>Access Key ID<input required name="accessKeyId" value="${esc(saved.accessKeyId)}"></label>
        <label>Secret Access Key<input required type="password" name="secretAccessKey" value="${esc(saved.secretAccessKey)}"></label>
        <label>Bucket 名称<input required name="bucket" value="${esc(saved.bucket)}"></label>
        <label>
          图片域名 Base URL (可选)
          <input name="imgBaseUrl" placeholder="例如：https://cdn.example.com 或 https://pub-xxx.r2.dev" value="${esc(currentBaseUrl)}">
          <small style="color: var(--muted); font-size: 0.8rem; display: block; margin-top: 4px;">
            用于公开直链加速、图片外链复制及分享。留空则通过 R2 接口获取。
          </small>
        </label>
        <button type="submit" class="primary">测试连接并保存</button>
      </form>
      <p class="help" style="margin-top: 14px;">详细开通与 CORS 配置请见 <a href="./README.md" target="_blank">README.md</a>。</p>
    </section>
  `;

  document.querySelector('#setup-form').onsubmit = async (event) => {
    event.preventDefault();
    const formData = new FormData(event.target);
    const imgBaseUrl = formData.get('imgBaseUrl');
    const rawValues = {
      accountId: formData.get('accountId') || '',
      accessKeyId: formData.get('accessKeyId') || '',
      secretAccessKey: formData.get('secretAccessKey') || '',
      bucket: formData.get('bucket') || ''
    };

    // 自动去除输入项的前后空白字符以提高容错
    const values = {
      accountId: rawValues.accountId.trim(),
      accessKeyId: rawValues.accessKeyId.trim(),
      secretAccessKey: rawValues.secretAccessKey.trim(),
      bucket: rawValues.bucket.trim()
    };

    const submitBtn = event.target.querySelector('button');
    submitBtn.disabled = true;
    submitBtn.textContent = '正在测试连接…';

    try {
      const client = new R2(values);
      await client.list('meta/', undefined);
      config.set(values);
      config.setImgBaseUrl(imgBaseUrl);
      r2 = client;
      index = await loadIndex(r2);
      renderApp();
    } catch (error) {
      console.error('测试连接失败:', error);
      toast(`连接失败：${error.message}`, true);
      // 弹出详细排查弹窗，传入错误对象与用户原始输入
      showConnectionErrorModal(error, rawValues);
      submitBtn.disabled = false;
      submitBtn.textContent = '测试连接并保存';
    }
  };
}

/**
 * 上传日志视图
 */
function renderUploadLogs() {
  const logs = listUploadLogs();
  app.innerHTML = `
    <section class="setup upload-log-view">
      <h1>📋 上传日志</h1>
      <p>上传日志仅保存在当前浏览器本地。清空日志不会影响云端已上传的照片。</p>
      <div class="log-actions">
        <button id="btn-log-back">返回相册</button>
        <button id="btn-clear-logs" class="danger">清空上传日志</button>
      </div>
      <div class="upload-log-list">
        ${logs.length ? logs.map(log => `
          <article class="upload-log-item ${esc(log.status)}">
            <div class="upload-log-head">
              <strong>${log.status === 'success' ? '✅ 成功' : log.status === 'failed' ? '❌ 失败' : '⏳ 上传中'}</strong>
              <span>${esc(formatDateTime(log.finishedAt || log.startedAt))}</span>
            </div>
            <p class="upload-log-name">${esc(log.fileName || '-')}</p>
            <p>大小：${esc(formatSize(Number(log.fileSize)))}</p>
            ${log.r2Key ? `<p>对象 Key：<code>${esc(log.r2Key)}</code></p>` : ''}
            ${log.error ? `<p class="upload-log-error">错误：${esc(log.error)}</p>` : ''}
            <p>开始：${esc(formatDateTime(log.startedAt))}</p>
            <p>完成：${esc(formatDateTime(log.finishedAt))}</p>
          </article>
        `).join('') : '<p class="empty-state">暂无上传日志记录。</p>'}
      </div>
    </section>
  `;

  document.querySelector('#btn-log-back').onclick = () => renderApp();
  document.querySelector('#btn-clear-logs').onclick = () => {
    if (!confirm('确定清空本地上传日志？')) return;
    clearUploadLogs();
    renderUploadLogs();
  };
}

/**
 * 全屏大图查看器
 */
function openViewer(photo, photos) {
  currentViewerIndex = photos.indexOf(photo);
  const publicUrl = getPublicImageUrl(photo.key);
  const formattedDate = format(photo.takenAt || photo.uploadedAt);
  const formattedSize = formatSize(Number(photo.size));
  const fullDateTime = formatDateTime(photo.takenAt || photo.uploadedAt);

  const dialogHtml = `
    <dialog open id="viewer">
      <header id="viewer-header">
        <div class="viewer-header-left">
          <button id="viewer-info-btn" class="viewer-icon-btn" aria-label="查看信息" title="查看图片元数据 (i)">ℹ️</button>
          <div id="viewer-info-popover" class="viewer-popover" hidden>
            <div class="popover-header">
              <strong>图片详情</strong>
              <button id="close-info-popover" class="popover-close-btn" aria-label="关闭信息">×</button>
            </div>
            <div class="popover-body">
              <div class="popover-row"><span class="popover-label">文件名：</span><span class="popover-val" id="popover-name">${esc(photo.name)}</span></div>
              <div class="popover-row"><span class="popover-label">文件大小：</span><span class="popover-val">${photo.size} 字节 (${formattedSize})</span></div>
              <div class="popover-row"><span class="popover-label">分辨率：</span><span class="popover-val">${photo.dimensions || '未知'}</span></div>
              <div class="popover-row"><span class="popover-label">拍摄/上传：</span><span class="popover-val">${fullDateTime}</span></div>
              <div class="popover-row"><span class="popover-label">所属相册：</span><span class="popover-val">${esc(photo.album || '未分类')}</span></div>
              <div class="popover-row"><span class="popover-label">存储路径：</span><span class="popover-val code">${esc(photo.key)}</span></div>
              <div class="popover-row"><span class="popover-label">图片外链：</span><span class="popover-val">${publicUrl ? `<a href="${publicUrl}" target="_blank" rel="noopener noreferrer">点击打开</a>` : '未配置'}</span></div>
            </div>
          </div>
        </div>
        <div id="viewer-meta-top" title="${esc(photo.name)} · ${formattedDate} · ${formattedSize}">
          <span class="meta-name" id="viewer-meta-name">${esc(photo.name)}</span>
          <span class="meta-divider">·</span>
          <span class="meta-date">${formattedDate}</span>
          <span class="meta-divider">·</span>
          <span class="meta-size">${formattedSize}</span>
        </div>
        <div class="viewer-header-right">
          <button id="close" aria-label="关闭" title="关闭查看器 (Esc)">×</button>
        </div>
      </header>

      <div id="image-stage">
        <button id="prev" class="viewer-nav-btn prev" aria-label="上一张" title="上一张 (←)">‹</button>
        <img alt="${esc(photo.name)}" title="双击放大 / 还原">
        <button id="next" class="viewer-nav-btn next" aria-label="下一张" title="下一张 (→)">›</button>
      </div>

      <footer>
        <button id="rename-photo" title="重命名图片"><span class="btn-icon">✏️</span><span class="btn-text">重命名</span></button>
        <button id="move-photo" title="移动到相册"><span class="btn-icon">📁</span><span class="btn-text">移动</span></button>
        <button id="crop-photo" title="矩形裁切图片"><span class="btn-icon">✂️</span><span class="btn-text">裁切</span></button>
        <button id="share" title="分享图片"><span class="btn-icon">📤</span><span class="btn-text">分享</span></button>
        <button id="get" title="下载此图片"><span class="btn-icon">⬇️</span><span class="btn-text">下载</span></button>
        <button id="remove" class="danger" title="删除此图片"><span class="btn-icon">🗑️</span><span class="btn-text">删除</span></button>
      </footer>
    </dialog>
  `;

  // 如果已经有残留的 viewer 则先清理
  const oldDialog = document.querySelector('#viewer');
  if (oldDialog) oldDialog.remove();

  document.body.insertAdjacentHTML('beforeend', dialogHtml);

  const img = document.querySelector('#image-stage img');

  // 1. 缩略图秒开占位（Blur-up / 零等待）：从当前页面已有的缩略图或缓存中即时提取展示
  const thumbnailEl = document.querySelector(`img[data-key="${CSS.escape(photo.key)}"]`);
  const existingThumbSrc = thumbnailEl ? thumbnailEl.src : getCachedImageUrl(photo.key);
  if (existingThumbSrc) {
    img.src = existingThumbSrc;
    img.style.filter = 'blur(4px)';
    img.style.transition = 'filter 0.25s ease';
  }

  // 2. 异步拉取高清大图，并在加载完成后丝滑替换并清除模糊
  loadPhotoHighResUrl(photo.key)
    .then(highResUrl => {
      if (!img || !document.querySelector('#viewer')) return;
      const tempImg = new Image();
      tempImg.onload = () => {
        if (!img || !document.querySelector('#viewer')) return;
        img.src = highResUrl;
        img.style.filter = 'none';
      };
      tempImg.src = highResUrl;
    })
    .catch(err => {
      toast(`高清大图加载失败：${err.message}`, true);
    });

  // 3. 智能后台预加载：自动预加载上一张与下一张照片的高清图，确保切图秒开
  if (photos && photos.length > 1) {
    const prevIdx = (currentViewerIndex - 1 + photos.length) % photos.length;
    const nextIdx = (currentViewerIndex + 1) % photos.length;
    setTimeout(() => {
      preloadPhoto(photos[nextIdx]);
      preloadPhoto(photos[prevIdx]);
    }, 150);
  }

  const dialog = document.querySelector('#viewer');
  const infoBtn = document.querySelector('#viewer-info-btn');
  const infoPopover = document.querySelector('#viewer-info-popover');
  const closeInfoBtn = document.querySelector('#close-info-popover');

  const switchPhoto = (delta) => {
    cleanupListeners();
    dialog.remove();
    const nextIdx = (currentViewerIndex + delta + photos.length) % photos.length;
    openViewer(photos[nextIdx], photos);
  };

  const closeViewer = () => {
    cleanupListeners();
    dialog.remove();
  };

  const viewerKeyHandler = (e) => {
    if (e.key === 'Escape') {
      if (infoPopover && !infoPopover.hidden) {
        infoPopover.hidden = true;
      } else {
        closeViewer();
      }
    } else if (e.key === 'ArrowLeft') {
      switchPhoto(-1);
    } else if (e.key === 'ArrowRight') {
      switchPhoto(1);
    } else if (e.key.toLowerCase() === 'i') {
      togglePopover();
    }
  };

  // 点击非对话框/非popover区域关闭信息面板
  const onDocClick = (e) => {
    if (!infoPopover || infoPopover.hidden) return;
    if (!infoPopover.contains(e.target) && e.target !== infoBtn && !infoBtn.contains(e.target)) {
      infoPopover.hidden = true;
    }
  };

  const togglePopover = () => {
    if (infoPopover) {
      infoPopover.hidden = !infoPopover.hidden;
    }
  };

  const cleanupListeners = () => {
    document.removeEventListener('keydown', viewerKeyHandler);
    document.removeEventListener('click', onDocClick, true);
  };

  document.addEventListener('keydown', viewerKeyHandler);
  document.addEventListener('click', onDocClick, true);

  if (infoBtn) {
    infoBtn.onclick = (e) => {
      e.stopPropagation();
      togglePopover();
    };
  }

  if (closeInfoBtn) {
    closeInfoBtn.onclick = (e) => {
      e.stopPropagation();
      if (infoPopover) infoPopover.hidden = true;
    };
  }

  document.querySelector('#close').onclick = closeViewer;
  document.querySelector('#prev').onclick = (e) => {
    e.stopPropagation();
    switchPhoto(-1);
  };
  document.querySelector('#next').onclick = (e) => {
    e.stopPropagation();
    switchPhoto(1);
  };
  document.querySelector('#get').onclick = () => download(photo);

  // 单张图片重命名
  document.querySelector('#rename-photo').onclick = async () => {
    const currentName = photo.name;
    const newName = prompt('请输入新文件名（包含扩展名）：', currentName);
    if (!newName) return;
    const trimmed = newName.trim();
    if (!trimmed || trimmed === currentName) return;

    photo.name = trimmed;
    await save();
    renderApp();

    const metaNameEl = document.querySelector('#viewer-meta-name');
    if (metaNameEl) metaNameEl.textContent = trimmed;
    const popoverNameEl = document.querySelector('#popover-name');
    if (popoverNameEl) popoverNameEl.textContent = trimmed;
    if (img) img.alt = trimmed;

    toast(`图片已成功重命名为「${trimmed}」`);
  };

  // 单张图片移动相册
  document.querySelector('#move-photo').onclick = () => {
    openMoveAlbumDialog([photo.id], (targetAlbum) => {
      photo.album = targetAlbum || '';
      const popoverAlbumEl = document.querySelector('#viewer-info-popover .popover-val:nth-child(5)');
      if (popoverAlbumEl) popoverAlbumEl.textContent = targetAlbum || '未分类';
      toast(targetAlbum ? `图片已移入相册「${targetAlbum}」` : '图片已移至未分类');
    });
  };

  // 矩形裁切按钮
  const cropBtn = document.querySelector('#crop-photo');
  if (cropBtn) {
    cropBtn.onclick = () => {
      openCropModal(photo);
    };
  }

  document.querySelector('#share').onclick = async () => {
    try {
      toast('正在准备分享文件…');
      const res = await r2.get(photo.key);
      const blob = await res.blob();
      const file = new File([blob], photo.name, { type: blob.type || 'image/jpeg' });

      // 优先尝试以图片文件形式发起系统分享（QQ、微信等应用接收图片消息）
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({
          files: [file],
          title: photo.name
        });
        return;
      }

      // 如果浏览器不支持文件分享，但配置了直链且支持URL分享
      const pubUrl = getPublicImageUrl(photo.key);
      if (pubUrl && navigator.share) {
        await navigator.share({
          title: photo.name,
          text: `${photo.name} - 云端相册`,
          url: pubUrl
        });
        return;
      }

      // 降级复制链接或提示
      if (pubUrl) {
        const ok = await copyToClipboard(pubUrl);
        toast(ok ? '当前环境不支持直接分享图片，已复制图片链接' : '当前环境不支持文件分享');
      } else {
        toast('当前浏览器或系统不支持原生图片分享', true);
      }
    } catch (e) {
      if (e.name !== 'AbortError') toast(`分享失败：${e.message}`, true);
    }
  };

  document.querySelector('#remove').onclick = async () => {
    selected = new Set([photo.id]);
    closeViewer();
    await batchDelete();
  };

  initViewerZoomAndPan(document.querySelector('#image-stage'), () => switchPhoto(-1), () => switchPhoto(1));
}

/**
 * 图片平移拖拽、鼠标滚轮缩放、移动端双指捏合缩放及轻扫切图支持
 */
function initViewerZoomAndPan(stage, onPrev, onNext) {
  if (!stage) return;
  const img = stage.querySelector('img');
  if (!img) return;

  let scale = 1;
  let translateX = 0;
  let translateY = 0;
  let isDragging = false;
  let startX = 0;
  let startY = 0;
  let initialTranslateX = 0;
  let initialTranslateY = 0;
  let activePointers = new Map();
  let initialPinchDistance = 0;
  let initialPinchScale = 1;

  const minScale = 0.5;
  const maxScale = 5;

  const updateTransform = (smooth = false) => {
    img.style.transition = smooth ? 'transform 0.2s cubic-bezier(0.16, 1, 0.3, 1)' : 'none';
    img.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;
    img.style.cursor = scale > 1 ? (isDragging ? 'grabbing' : 'grab') : 'default';
  };

  const resetZoom = (smooth = true) => {
    scale = 1;
    translateX = 0;
    translateY = 0;
    updateTransform(smooth);
  };

  // 鼠标滚轮缩放
  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    const zoomFactor = e.deltaY < 0 ? 1.15 : 0.87;
    const newScale = Math.min(Math.max(scale * zoomFactor, minScale), maxScale);

    if (newScale === scale) return;

    if (newScale <= 1) {
      scale = 1;
      translateX = 0;
      translateY = 0;
    } else {
      const rect = stage.getBoundingClientRect();
      const mouseX = e.clientX - (rect.left + rect.width / 2);
      const mouseY = e.clientY - (rect.top + rect.height / 2);

      translateX -= (mouseX - translateX) * (zoomFactor - 1);
      translateY -= (mouseY - translateY) * (zoomFactor - 1);
      scale = newScale;
    }
    updateTransform(false);
  }, { passive: false });

  // 双击快速放大/复原
  stage.addEventListener('dblclick', (e) => {
    e.preventDefault();
    if (scale > 1.2) {
      resetZoom(true);
    } else {
      scale = 2.5;
      const rect = stage.getBoundingClientRect();
      const mouseX = e.clientX - (rect.left + rect.width / 2);
      const mouseY = e.clientY - (rect.top + rect.height / 2);
      translateX = -mouseX * 0.8;
      translateY = -mouseY * 0.8;
      updateTransform(true);
    }
  });

  // 指针按下（过滤掉左右切换按钮，不捕获指针以免吞噬 button click）
  stage.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.viewer-nav-btn')) return;

    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { stage.setPointerCapture(e.pointerId); } catch {}

    if (activePointers.size === 1) {
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      initialTranslateX = translateX;
      initialTranslateY = translateY;
      img.style.transition = 'none';
    } else if (activePointers.size === 2) {
      isDragging = false;
      const pts = Array.from(activePointers.values());
      initialPinchDistance = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      initialPinchScale = scale;
    }
  });

  // 指针移动
  stage.addEventListener('pointermove', (e) => {
    if (!activePointers.has(e.pointerId)) return;
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (activePointers.size === 1 && isDragging) {
      const deltaX = e.clientX - startX;
      const deltaY = e.clientY - startY;

      if (scale > 1) {
        translateX = initialTranslateX + deltaX;
        translateY = initialTranslateY + deltaY;
        updateTransform(false);
      }
    } else if (activePointers.size === 2) {
      const pts = Array.from(activePointers.values());
      const currentDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      if (initialPinchDistance > 0) {
        const factor = currentDist / initialPinchDistance;
        scale = Math.min(Math.max(initialPinchScale * factor, minScale), maxScale);
        updateTransform(false);
      }
    }
  });

  // 指针抬起或取消
  const onPointerEnd = (e) => {
    if (activePointers.has(e.pointerId)) {
      const startPt = { x: startX, y: startY };
      const endPt = { x: e.clientX, y: e.clientY };
      const deltaX = endPt.x - startPt.x;
      const deltaY = endPt.y - startPt.y;

      activePointers.delete(e.pointerId);

      // 如果未放大（scale <= 1），单指水平轻扫超出阈值触发切图
      if (scale <= 1 && Math.abs(deltaX) > 60 && Math.abs(deltaY) < 100) {
        if (deltaX < 0) {
          onNext?.();
        } else {
          onPrev?.();
        }
      }

      if (scale < 1) {
        resetZoom(true);
      }
    }

    if (activePointers.size === 0) {
      isDragging = false;
      img.style.cursor = scale > 1 ? 'grab' : 'default';
    }
  };

  stage.addEventListener('pointerup', onPointerEnd);
  stage.addEventListener('pointercancel', onPointerEnd);
}

/**
 * 手势滑动与双击缩放支持 (向下兼容保留)
 */
function gesture(stage, left, right) {
  initViewerZoomAndPan(stage, left, right);
}

/**
 * 打开图片裁切模态框
 * @param {Object} photo 照片对象
 */
async function openCropModal(photo) {
  if (!photo) return;
  toast('正在加载图片…');
  let imageBlob = null;
  let imageUrl = null;
  try {
    const res = await r2.get(photo.key);
    imageBlob = await res.blob();
    imageUrl = URL.createObjectURL(imageBlob);
  } catch (err) {
    toast(`加载图片失败：${err.message}`, true);
    return;
  }

  const modalHtml = `
    <div id="crop-modal" role="dialog" aria-modal="true" aria-label="图片裁切">
      <div class="crop-header">
        <h3><span>✂️</span> <span>矩形裁切</span></h3>
        <div class="crop-info-text" id="crop-dimensions">选框：0 × 0 px</div>
      </div>
      <div class="crop-stage-container" id="crop-stage">
        <div class="crop-wrapper" id="crop-wrapper">
          <img class="crop-image" id="crop-target-img" src="${imageUrl}" alt="${esc(photo.name)}" crossorigin="anonymous">
          <div class="crop-box" id="crop-box">
            <div class="crop-grid">
              <div class="crop-grid-line-h1"></div>
              <div class="crop-grid-line-h2"></div>
              <div class="crop-grid-line-v1"></div>
              <div class="crop-grid-line-v2"></div>
            </div>
            <div class="crop-handle handle-nw" data-handle="nw"></div>
            <div class="crop-handle handle-n" data-handle="n"></div>
            <div class="crop-handle handle-ne" data-handle="ne"></div>
            <div class="crop-handle handle-w" data-handle="w"></div>
            <div class="crop-handle handle-e" data-handle="e"></div>
            <div class="crop-handle handle-sw" data-handle="sw"></div>
            <div class="crop-handle handle-s" data-handle="s"></div>
            <div class="crop-handle handle-se" data-handle="se"></div>
          </div>
        </div>
      </div>
      <div class="crop-footer">
        <button id="crop-btn-save" class="primary" title="保存裁切结果到未分类相册"><span>💾</span><span>保存至相册</span></button>
        <button id="crop-btn-download" class="secondary" title="下载裁切图片到本地"><span>⬇️</span><span>下载</span></button>
        <button id="crop-btn-share" class="secondary" title="分享裁切后的图片"><span>📤</span><span>分享</span></button>
        <button id="crop-btn-cancel" class="cancel" title="取消裁切"><span>❌</span><span>取消</span></button>
      </div>
    </div>
  `;

  // 清除旧模态框
  const oldModal = document.querySelector('#crop-modal');
  if (oldModal) oldModal.remove();

  document.body.insertAdjacentHTML('beforeend', modalHtml);

  const modal = document.querySelector('#crop-modal');
  const imgEl = modal.querySelector('#crop-target-img');
  const cropBox = modal.querySelector('#crop-box');
  const wrapper = modal.querySelector('#crop-wrapper');
  const infoEl = modal.querySelector('#crop-dimensions');

  let cropState = {
    x: 0,
    y: 0,
    w: 0,
    h: 0,
    imgNaturalW: 0,
    imgNaturalH: 0,
    imgRenderW: 0,
    imgRenderH: 0
  };

  const updateCropBoxStyle = () => {
    cropBox.style.left = `${cropState.x}px`;
    cropBox.style.top = `${cropState.y}px`;
    cropBox.style.width = `${cropState.w}px`;
    cropBox.style.height = `${cropState.h}px`;

    // 计算实际裁剪像素分辨率
    if (cropState.imgRenderW > 0 && cropState.imgRenderH > 0) {
      const scaleX = cropState.imgNaturalW / cropState.imgRenderW;
      const scaleY = cropState.imgNaturalH / cropState.imgRenderH;
      const realW = Math.round(cropState.w * scaleX);
      const realH = Math.round(cropState.h * scaleY);
      infoEl.textContent = `选区：${realW} × ${realH} px`;
    }
  };

  const initCropBox = () => {
    cropState.imgNaturalW = imgEl.naturalWidth;
    cropState.imgNaturalH = imgEl.naturalHeight;
    cropState.imgRenderW = imgEl.clientWidth;
    cropState.imgRenderH = imgEl.clientHeight;

    // 默认选框：居中 80% 大小
    const marginRatio = 0.1;
    cropState.w = Math.max(30, Math.round(cropState.imgRenderW * (1 - 2 * marginRatio)));
    cropState.h = Math.max(30, Math.round(cropState.imgRenderH * (1 - 2 * marginRatio)));
    cropState.x = Math.round((cropState.imgRenderW - cropState.w) / 2);
    cropState.y = Math.round((cropState.imgRenderH - cropState.h) / 2);

    updateCropBoxStyle();
  };

  if (imgEl.complete && imgEl.naturalWidth > 0) {
    initCropBox();
  } else {
    imgEl.onload = () => initCropBox();
  }

  // 窗口缩放自适应重新校准
  const onWindowResize = () => {
    if (!modal.isConnected || !imgEl.clientWidth) return;
    const oldRenderW = cropState.imgRenderW || imgEl.clientWidth;
    const oldRenderH = cropState.imgRenderH || imgEl.clientHeight;
    cropState.imgRenderW = imgEl.clientWidth;
    cropState.imgRenderH = imgEl.clientHeight;

    const ratioX = cropState.imgRenderW / oldRenderW;
    const ratioY = cropState.imgRenderH / oldRenderH;

    cropState.x = Math.max(0, Math.min(cropState.imgRenderW - 20, cropState.x * ratioX));
    cropState.y = Math.max(0, Math.min(cropState.imgRenderH - 20, cropState.y * ratioY));
    cropState.w = Math.max(20, Math.min(cropState.imgRenderW - cropState.x, cropState.w * ratioX));
    cropState.h = Math.max(20, Math.min(cropState.imgRenderH - cropState.y, cropState.h * ratioY));

    updateCropBoxStyle();
  };
  window.addEventListener('resize', onWindowResize);

  // 拖动选框与手柄拉伸逻辑
  let isInteracting = false;
  let activeAction = null; // 'move' 或 手柄名 'nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'
  let startPointerX = 0;
  let startPointerY = 0;
  let startBox = { x: 0, y: 0, w: 0, h: 0 };
  const minBoxSize = 20;

  const onPointerDown = (e) => {
    const handle = e.target.closest('.crop-handle');
    if (handle) {
      activeAction = handle.dataset.handle;
    } else if (e.target.closest('#crop-box')) {
      activeAction = 'move';
    } else {
      return;
    }

    isInteracting = true;
    startPointerX = e.clientX;
    startPointerY = e.clientY;
    startBox = { x: cropState.x, y: cropState.y, w: cropState.w, h: cropState.h };

    modal.setPointerCapture(e.pointerId);
    e.preventDefault();
    e.stopPropagation();
  };

  const onPointerMove = (e) => {
    if (!isInteracting || !activeAction) return;

    const dx = e.clientX - startPointerX;
    const dy = e.clientY - startPointerY;
    const maxW = cropState.imgRenderW;
    const maxH = cropState.imgRenderH;

    if (activeAction === 'move') {
      let newX = startBox.x + dx;
      let newY = startBox.y + dy;
      // 边界限制
      newX = Math.max(0, Math.min(maxW - startBox.w, newX));
      newY = Math.max(0, Math.min(maxH - startBox.h, newY));
      cropState.x = newX;
      cropState.y = newY;
    } else {
      let newLeft = startBox.x;
      let newTop = startBox.y;
      let newRight = startBox.x + startBox.w;
      let newBottom = startBox.y + startBox.h;

      if (activeAction.includes('w')) {
        newLeft = Math.max(0, Math.min(newRight - minBoxSize, startBox.x + dx));
      }
      if (activeAction.includes('e')) {
        newRight = Math.min(maxW, Math.max(newLeft + minBoxSize, startBox.x + startBox.w + dx));
      }
      if (activeAction.includes('n')) {
        newTop = Math.max(0, Math.min(newBottom - minBoxSize, startBox.y + dy));
      }
      if (activeAction.includes('s')) {
        newBottom = Math.min(maxH, Math.max(newTop + minBoxSize, startBox.y + startBox.h + dy));
      }

      cropState.x = newLeft;
      cropState.y = newTop;
      cropState.w = newRight - newLeft;
      cropState.h = newBottom - newTop;
    }

    updateCropBoxStyle();
  };

  const onPointerUp = (e) => {
    if (isInteracting) {
      isInteracting = false;
      activeAction = null;
      try {
        modal.releasePointerCapture(e.pointerId);
      } catch {}
    }
  };

  modal.addEventListener('pointerdown', onPointerDown);
  modal.addEventListener('pointermove', onPointerMove);
  modal.addEventListener('pointerup', onPointerUp);
  modal.addEventListener('pointercancel', onPointerUp);

  const cleanupModal = () => {
    window.removeEventListener('resize', onWindowResize);
    modal.removeEventListener('pointerdown', onPointerDown);
    modal.removeEventListener('pointermove', onPointerMove);
    modal.removeEventListener('pointerup', onPointerUp);
    modal.removeEventListener('pointercancel', onPointerUp);
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    modal.remove();
  };

  // 生成裁切后的 Blob 及图片对象（支持超大分辨率自适应优化与防模糊插值）
  const generateCroppedBlob = async () => {
    const scaleX = cropState.imgNaturalW / cropState.imgRenderW;
    const scaleY = cropState.imgNaturalH / cropState.imgRenderH;

    const sourceX = Math.round(cropState.x * scaleX);
    const sourceY = Math.round(cropState.y * scaleY);
    let targetW = Math.round(cropState.w * scaleX);
    let targetH = Math.round(cropState.h * scaleY);

    // 最大边长限制在 3840px (4K 超高清)，既保证极端细腻的画质，又防止手机原图裁切后文件体积爆炸
    const maxSide = 3840;
    const maxDimension = Math.max(targetW, targetH);
    if (maxDimension > maxSide) {
      const resizeRatio = maxSide / maxDimension;
      targetW = Math.round(targetW * resizeRatio);
      targetH = Math.round(targetH * resizeRatio);
    }

    const canvas = document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    // 绘制裁切部分
    ctx.drawImage(
      imgEl,
      sourceX, sourceY, Math.round(cropState.w * scaleX), Math.round(cropState.h * scaleY),
      0, 0, targetW, targetH
    );

    // 获取原始图片的 mimeType，平衡清晰度与体积
    const mimeType = imageBlob.type || 'image/jpeg';
    const quality = mimeType === 'image/png' ? undefined : 0.88;
    const blob = await new Promise((resolve) => {
      canvas.toBlob(resolve, mimeType, quality);
    });

    return { blob, width: targetW, height: targetH, mimeType };
  };

  // 生成新文件名：原文件名-裁剪.ext
  const generateCroppedName = (originalName) => {
    const lastDot = originalName.lastIndexOf('.');
    if (lastDot > 0) {
      const base = originalName.substring(0, lastDot);
      const ext = originalName.substring(lastDot);
      return `${base}-裁剪${ext}`;
    }
    return `${originalName}-裁剪.jpg`;
  };

  // 保存到云盘（未分类）
  modal.querySelector('#crop-btn-save').onclick = async () => {
    const saveBtn = modal.querySelector('#crop-btn-save');
    saveBtn.disabled = true;
    toast('正在生成并上传裁切图片…');

    try {
      const { blob, width, height, mimeType } = await generateCroppedBlob();
      const croppedName = generateCroppedName(photo.name);
      const date = new Date();
      const ext = (croppedName.split('.').pop() || 'jpg').toLowerCase();
      const key = `photos/${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}/${uuid()}.${ext}`;

      const file = new File([blob], croppedName, { type: mimeType });

      // 上传到 R2
      await r2.put(key, file, (done, total) => {
        toast(`正在上传裁切图片 ${Math.round((done / total) * 100)}%`);
      });

      const newPhoto = {
        id: uuid(),
        key,
        name: croppedName,
        size: blob.size,
        takenAt: date.toISOString(),
        uploadedAt: date.toISOString(),
        album: '', // 标记为未分类
        tags: [],
        dimensions: `${width} × ${height}`,
        trashed: false
      };

      index.photos.unshift(newPhoto);
      await save();
      cleanupModal();
      renderApp();
      toast(`裁切图片已保存为「${croppedName}」（未分类）`);
    } catch (err) {
      toast(`保存失败：${err.message}`, true);
      saveBtn.disabled = false;
    }
  };

  // 下载到本地
  modal.querySelector('#crop-btn-download').onclick = async () => {
    try {
      toast('正在导出裁切图片…');
      const { blob } = await generateCroppedBlob();
      const croppedName = generateCroppedName(photo.name);
      const a = Object.assign(document.createElement('a'), {
        href: URL.createObjectURL(blob),
        download: croppedName
      });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      toast(`已开始下载「${croppedName}」`);
    } catch (err) {
      toast(`下载失败：${err.message}`, true);
    }
  };

  // 分享裁切图片
  modal.querySelector('#crop-btn-share').onclick = async () => {
    try {
      toast('正在准备分享裁切图片…');
      const { blob, mimeType } = await generateCroppedBlob();
      const croppedName = generateCroppedName(photo.name);
      const file = new File([blob], croppedName, { type: mimeType });

      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({
          files: [file],
          title: croppedName
        });
      } else {
        toast('当前浏览器或系统不支持直接分享图片文件，请先下载后发送。', true);
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        toast(`分享失败：${err.message}`, true);
      }
    }
  };

  // 取消
  modal.querySelector('#crop-btn-cancel').onclick = () => {
    cleanupModal();
  };
}

/**
 * 获取图片尺寸宽高
 */
async function imageDimensions(file) {
  try {
    const bitmap = await createImageBitmap(file);
    return `${bitmap.width} × ${bitmap.height}`;
  } catch {
    return '';
  }
}

/**
 * 接收 PWA 外部共享文件
 */
async function receiveShared() {
  if (!location.search.includes('share-target')) return;
  const cached = await caches.open('cloud-album-shell-v2').then(c => c.match('./shared-files'));
  if (!cached) return;
  const files = await cached.json();
  await caches.open('cloud-album-shell-v2').then(c => c.delete('./shared-files'));
  await upload(files.map(f => new File([new Uint8Array(f.data)], f.name, { type: f.type })));
  history.replaceState(null, '', './');
}

/**
 * 简易 Toast 提示
 */
function toast(message, error = false) {
  let node = document.querySelector('#toast');
  if (!node) return;
  node.textContent = message;
  node.className = error ? 'error' : '';
  node.style.display = 'block';
  node.style.opacity = '1';

  clearTimeout(node._hideTimeout);
  node._hideTimeout = setTimeout(() => {
    node.style.opacity = '0';
    setTimeout(() => { node.style.display = 'none'; }, 250);
  }, 2800);
}

// 启动应用
init();
