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
 * 初始化入口
 */
async function init() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
  
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
              <span class="btn-delete-album" data-delete-album="${esc(albumName)}" title="删除相册">🗑️</span>
            </div>
          </button>
        `;
      }).join('')}
      <button id="btn-new-album" class="btn-new-album">＋ 新建相册</button>
    </aside>
  ` : '';

  // 底部固定操作条 (上传、下载、删除)
  const isSelected = selected.size > 0;
  const bottomBarHtml = `
    <footer class="bottom-action-bar">
      <div class="bottom-bar-content">
        <div class="bottom-selection-info">
          <span>${isSelected ? `已选中 <b>${selected.size}</b> 项` : `共 <b>${filteredPhotos.length}</b> 项`}</span>
        </div>
        <div class="bottom-actions-group">
          ${view !== 'trash' ? '<button id="btn-bottom-upload" class="bottom-btn bottom-btn-upload">⬆️ 上传</button>' : ''}
          ${view === 'albums' && isSelected ? '<button id="btn-bottom-move-album" class="bottom-btn">📁 移入相册</button>' : ''}
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
      const response = await r2.get(key);
      const blob = await response.blob();
      img.src = URL.createObjectURL(blob);
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
      // 如果点击的是删除相册按钮，则不触发相册切换
      if (e.target.closest('[data-delete-album]')) return;
      currentAlbum = btn.dataset.album;
      selected.clear();
      renderApp();
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

  // 底部下载按钮
  const bottomDownloadBtn = document.querySelector('#btn-bottom-download');
  if (bottomDownloadBtn) {
    bottomDownloadBtn.onclick = () => batchDownload();
  }

  // 底部删除按钮
  const bottomDeleteBtn = document.querySelector('#btn-bottom-delete');
  if (bottomDeleteBtn) {
    bottomDeleteBtn.onclick = () => batchDelete();
  }

  // 底部移入相册按钮
  const bottomMoveAlbumBtn = document.querySelector('#btn-bottom-move-album');
  if (bottomMoveAlbumBtn) {
    bottomMoveAlbumBtn.onclick = () => batchMoveAlbum();
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
 * 批量下载选中的图片
 */
async function batchDownload() {
  if (!selected.size) return;
  const photos = filteredPhotos.filter(p => selected.has(p.id));
  toast(`正在准备下载 ${photos.length} 张照片…`);
  for (const photo of photos) {
    await download(photo);
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
 * 批量移动到相册
 */
async function batchMoveAlbum() {
  if (!selected.size) return;
  const albums = index.albums || [];
  const albumName = prompt(`请输入相册名称（现有相册：${albums.join('、') || '暂无'}）`);
  if (!albumName) return;
  
  const trimmed = albumName.trim();
  if (trimmed && !albums.includes(trimmed)) {
    index.albums.push(trimmed);
  }

  const photos = index.photos.filter(p => selected.has(p.id));
  photos.forEach(p => p.album = trimmed);

  selected.clear();
  await save();
  renderApp();
  toast(`已将选中照片移动至相册「${trimmed}」`);
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

  const dialogHtml = `
    <dialog open id="viewer">
      <button id="close" aria-label="关闭">×</button>
      <div id="image-stage">
        <img alt="${esc(photo.name)}">
      </div>
      <footer>
        <button id="prev" title="上一张">‹</button>
        <span>${esc(photo.name)} · ${formatSize(Number(photo.size))} · ${format(photo.takenAt || photo.uploadedAt)}</span>
        <button id="info">信息</button>
        ${publicUrl ? '<button id="copy-link" title="复制图片直链">复制外链</button>' : ''}
        <button id="share">分享</button>
        <button id="get">下载</button>
        <button id="remove" class="danger">删除</button>
        <button id="next" title="下一张">›</button>
      </footer>
    </dialog>
  `;

  app.insertAdjacentHTML('beforeend', dialogHtml);

  const img = document.querySelector('#image-stage img');

  // 加载大图逻辑：配置了图片域名则优先直链加载，失败或未配置时回退到 R2 SDK 拉取 Blob
  if (publicUrl) {
    img.onerror = async () => {
      img.onerror = null;
      try {
        const res = await r2.get(photo.key);
        const blob = await res.blob();
        img.src = URL.createObjectURL(blob);
      } catch (err) {
        toast(`图片加载失败：${err.message}`, true);
      }
    };
    img.src = publicUrl;
  } else {
    r2.get(photo.key)
      .then(res => res.blob())
      .then(blob => {
        if (img) img.src = URL.createObjectURL(blob);
      })
      .catch(err => toast(`图片加载失败：${err.message}`, true));
  }

  const dialog = document.querySelector('#viewer');
  const switchPhoto = (delta) => {
    dialog.remove();
    const nextIdx = (currentViewerIndex + delta + photos.length) % photos.length;
    openViewer(photos[nextIdx], photos);
  };

  document.querySelector('#close').onclick = () => dialog.remove();
  document.querySelector('#prev').onclick = () => switchPhoto(-1);
  document.querySelector('#next').onclick = () => switchPhoto(1);
  document.querySelector('#get').onclick = () => download(photo);

  // 复制直链按钮
  const copyLinkBtn = document.querySelector('#copy-link');
  if (copyLinkBtn) {
    copyLinkBtn.onclick = async () => {
      const url = getPublicImageUrl(photo.key);
      if (!url) {
        toast('请先在相册设置中配置图片域名 Base URL', true);
        return;
      }
      const ok = await copyToClipboard(url);
      if (ok) {
        toast('已复制图片直链到剪贴板 📋');
      } else {
        prompt('图片直链如下，可手动复制：', url);
      }
    };
  }

  document.querySelector('#info').onclick = () => {
    const pubUrl = getPublicImageUrl(photo.key);
    alert(
      `文件名：${photo.name}\n` +
      `大小：${photo.size} 字节 (${formatSize(Number(photo.size))})\n` +
      `分辨率：${photo.dimensions || '未知'}\n` +
      `拍摄/上传时间：${formatDateTime(photo.takenAt || photo.uploadedAt)}\n` +
      `所属相册：${photo.album || '未分类'}\n` +
      `存储路径：${photo.key}\n` +
      `图片外链：${pubUrl || '未配置（在设置中填入图片域名即可生成）'}`
    );
  };

  document.querySelector('#share').onclick = async () => {
    const pubUrl = getPublicImageUrl(photo.key);
    // 如果配置了图片外链且系统支持 URL 分享
    if (pubUrl && navigator.share) {
      try {
        await navigator.share({
          title: photo.name,
          text: `${photo.name} - 云端相册`,
          url: pubUrl
        });
        return;
      } catch (e) {
        if (e.name === 'AbortError') return;
      }
    }

    // 默认尝试原生文件分享
    try {
      const blob = await (await r2.get(photo.key)).blob();
      const file = new File([blob], photo.name, { type: blob.type });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ title: photo.name, files: [file] });
      } else if (pubUrl) {
        const ok = await copyToClipboard(pubUrl);
        toast(ok ? '已复制图片链接到剪贴板' : '已生成外链');
      } else {
        toast('当前浏览器环境不支持文件原生分享。', true);
      }
    } catch (e) {
      if (e.name !== 'AbortError') toast(`分享失败：${e.message}`, true);
    }
  };

  document.querySelector('#remove').onclick = async () => {
    selected = new Set([photo.id]);
    dialog.remove();
    await batchDelete();
  };

  gesture(document.querySelector('#image-stage'), () => switchPhoto(-1), () => switchPhoto(1));
}

/**
 * 手势滑动与双击缩放支持
 */
function gesture(stage, left, right) {
  if (!stage) return;
  let startX, scale = 1;
  stage.onpointerdown = e => {
    startX = e.clientX;
    stage.setPointerCapture(e.pointerId);
  };
  stage.onpointerup = e => {
    if (Math.abs(e.clientX - startX) > 60) {
      e.clientX < startX ? right() : left();
    }
  };
  stage.ondblclick = () => {
    scale = scale === 1 ? 2 : 1;
    const img = stage.querySelector('img');
    if (img) img.style.transform = `scale(${scale})`;
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
