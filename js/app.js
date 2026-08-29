import { R2 } from './r2.js';
import { config, loadIndex, saveIndex } from './index-store.js';
import { clearUploadLogs, createUploadLog, finishUploadLog, listUploadLogs } from './upload-log.js';

const app = document.querySelector('#app'), input = document.querySelector('#file-input');
let r2, index, view = 'timeline', selected = new Set(), current = null;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const format = value => new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium' }).format(new Date(value));
const formatDateTime = value => value ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(value)) : '-';
const formatSize = value => Number.isFinite(value) ? (value < 1024 ? `${value} B` : `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`) : '-';
const uuid = () => crypto.randomUUID();

async function init() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js');
  const saved = config.get();
  if (!saved) return renderSetup();
  r2 = new R2(saved);
  try { index = await loadIndex(r2); await receiveShared(); render(); } catch (error) { toast(`无法读取相册：${error.message}`, true); renderSetup(saved); }
}
function renderSetup(saved = {}) {
  app.innerHTML = `<section class="setup"><div class="logo">▣</div><h1>云端相册</h1><p>照片直接保存到您自己的 Cloudflare R2 桶。凭据仅保存在此设备浏览器中，不会上传到本网站。</p><ol><li>注册 Cloudflare 并创建 R2 存储桶</li><li>创建拥有对象读写权限的 R2 API 令牌</li><li>填写下面的四项凭据并测试连接</li></ol><form id="setup-form"><label>Account ID<input required name="accountId" value="${esc(saved.accountId)}"></label><label>Access Key ID<input required name="accessKeyId" value="${esc(saved.accessKeyId)}"></label><label>Secret Access Key<input required type="password" name="secretAccessKey" value="${esc(saved.secretAccessKey)}"></label><label>Bucket 名称<input required name="bucket" value="${esc(saved.bucket)}"></label><button>测试连接并保存</button></form><p class="help">详细开通与 CORS 配置请见 <a href="./README.md">README</a>。</p></section>`;
  document.querySelector('#setup-form').onsubmit = async event => { event.preventDefault(); const values = Object.fromEntries(new FormData(event.target)); const button = event.submitter; button.disabled = true; button.textContent = '正在测试…'; try { const client = new R2(values); await client.list('meta/', undefined); config.set(values); r2 = client; index = await loadIndex(r2); render(); } catch (error) { toast(`连接失败：${error.message}`, true); button.disabled = false; button.textContent = '测试连接并保存'; } };
}
function render() {
  const items = index.photos.filter(photo => view === 'trash' ? photo.trashed : !photo.trashed);
  app.innerHTML = `<header><strong>云端相册</strong><input id="search" type="search" placeholder="搜索文件名或标签"><button id="timeline">时间线</button><button id="albums">相册</button><button id="trash">回收站</button><button id="upload-logs">上传日志</button><button id="upload" class="primary">上传</button><button id="settings" aria-label="设置">⚙</button></header><section id="dropzone" class="content"><aside id="album-list">${albumLinks()}</aside><div id="toolbar">${selected.size ? `<span>已选 ${selected.size} 张</span><button data-action="album">移入相册</button><button data-action="download">下载</button><button data-action="delete">删除</button><button data-action="cancel">取消</button>` : view === 'trash' ? '<button data-action="empty">清空回收站</button>' : ''}</div><div id="gallery">${gallery(items)}</div></section><div id="toast" role="status"></div>`;
  bind(items); loadPreviews();
}
function albumLinks() { if (view !== 'albums') return ''; const albums = ['全部', '未分类', ...(index.albums || [])]; return `<h2>相册</h2>${albums.map(a => `<button class="album" data-album="${esc(a)}">${esc(a)}</button>`).join('')}<button id="new-album">＋ 新建相册</button>`; }
function gallery(items) {
  const grouped = view === 'timeline' ? items.reduce((groups, item) => { const day = format(item.takenAt || item.uploadedAt); (groups[day] ||= []).push(item); return groups; }, {}) : { '': items };
  return Object.entries(grouped).map(([day, photos]) => `<section class="day">${day ? `<h2>${day}</h2>` : ''}<div class="grid">${photos.map(photo => `<article class="photo ${selected.has(photo.id) ? 'selected' : ''}" data-id="${photo.id}"><img loading="lazy" data-key="${esc(photo.key)}" alt="${esc(photo.name)}"><span>${esc(photo.name)}</span></article>`).join('')}</div></section>`).join('') || '<p class="empty">这里还没有照片。点击“上传”开始吧。</p>';
}
async function loadPreviews() { for (const image of document.querySelectorAll('img[data-key]')) { try { image.src = URL.createObjectURL(await (await r2.get(image.dataset.key)).blob()); } catch { image.alt = '预览加载失败'; } } }
function bind(items) {
  document.querySelector('#upload').onclick = () => input.click();
  document.querySelector('#upload-logs').onclick = () => renderUploadLogs();
  document.querySelector('#settings').onclick = () => renderSettings();
  ['timeline', 'albums', 'trash'].forEach(id => document.querySelector(`#${id}`).onclick = () => { view = id; selected.clear(); render(); });
  document.querySelector('#search').oninput = event => document.querySelectorAll('.photo').forEach(card => card.hidden = !card.textContent.toLowerCase().includes(event.target.value.toLowerCase()));
  document.querySelector('#dropzone').ondragover = event => event.preventDefault();
  document.querySelector('#dropzone').ondrop = event => { event.preventDefault(); upload([...event.dataTransfer.files]); };
  document.querySelectorAll('.photo').forEach(card => {
    let hold; card.onpointerdown = () => hold = setTimeout(() => { selected.add(card.dataset.id); render(); }, 550);
    card.onpointerup = () => clearTimeout(hold);
    card.onclick = () => selected.size ? (selected.has(card.dataset.id) ? selected.delete(card.dataset.id) : selected.add(card.dataset.id), render()) : openViewer(items.find(p => p.id === card.dataset.id), items);
  });
  document.querySelectorAll('[data-action]').forEach(button => button.onclick = () => action(button.dataset.action));
  document.querySelectorAll('[data-album]').forEach(button => button.onclick = () => { const album = button.dataset.album; const items = index.photos.filter(p => !p.trashed && (album === '全部' || (album === '未分类' ? !p.album : p.album === album))); document.querySelector('#gallery').innerHTML = gallery(items); bind(items); });
  const newAlbum = document.querySelector('#new-album'); if (newAlbum) newAlbum.onclick = () => { const name = prompt('相册名称'); if (name && !index.albums.includes(name)) { index.albums.push(name); save().then(render); } };
}
input.onchange = () => upload([...input.files]);
async function upload(files) {
  if (!files.length) return;
  const lock = navigator.wakeLock && await navigator.wakeLock.request('screen').catch(() => null);
  for (const file of files.filter(f => f.type.startsWith('image/'))) {
    const startedAt = new Date().toISOString();
    const logId = createUploadLog({ fileName: file.name, fileSize: file.size, startedAt });
    const date = new Date(), ext = (file.name.split('.').pop() || 'jpg').toLowerCase(), key = `photos/${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}/${uuid()}.${ext}`;
    try { toast(`正在上传 ${file.name}…`); await r2.put(key, file, (done, total) => toast(`正在上传 ${file.name} ${Math.round(done / total * 100)}%`)); const dimensions = await imageDimensions(file); index.photos.unshift({ id: uuid(), key, name: file.name, size: file.size, takenAt: date.toISOString(), uploadedAt: date.toISOString(), album: '', tags: [], dimensions, trashed: false }); await save(); finishUploadLog(logId, { status: 'success', r2Key: key, finishedAt: new Date().toISOString() }); } catch (error) { finishUploadLog(logId, { status: 'failed', r2Key: key, error: error?.message || String(error), finishedAt: new Date().toISOString() }); toast(`${file.name} 上传失败：${error.message}`, true); }
  }
  lock?.release(); input.value = ''; render();
}
async function save() { await saveIndex(r2, index); }
async function action(name) {
  const photos = index.photos.filter(p => selected.has(p.id));
  if (name === 'cancel') { selected.clear(); return render(); }
  if (name === 'album') { const album = prompt(`输入相册名称（已有：${index.albums.join('、')}）`); if (!album) return; if (!index.albums.includes(album)) index.albums.push(album); photos.forEach(p => p.album = album); }
  if (name === 'download') return Promise.all(photos.map(download));
  if (name === 'delete') { if (!confirm(`将 ${photos.length} 张照片移入回收站？`)) { selected.clear(); return render(); } for (const p of photos) { const trash = p.key.replace(/^photos\//, 'trash/'); await r2.copy(p.key, trash); await r2.delete(p.key); p.key = trash; p.trashed = true; p.deletedAt = new Date().toISOString(); } }
  if (name === 'empty') { if (!confirm('确定彻底删除回收站中的所有照片？此操作无法撤销。')) return; for (const p of index.photos.filter(p => p.trashed)) await r2.delete(p.key); index.photos = index.photos.filter(p => !p.trashed); }
  selected.clear(); await save(); render();
}
async function download(photo) { const blob = await (await r2.get(photo.key)).blob(); const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: photo.name }); a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); }
function renderSettings() { app.innerHTML = `<section class="setup"><h1>设置</h1><p>R2 凭据只保存在本浏览器 localStorage。</p><button id="edit">修改凭据</button><button id="clear" class="danger">清除本机凭据</button><button id="back">返回相册</button></section>`; document.querySelector('#edit').onclick = () => renderSetup(config.get()); document.querySelector('#clear').onclick = () => { if (confirm('确定清除本机保存的 R2 凭据？')) { config.clear(); renderSetup(); } }; document.querySelector('#back').onclick = render; }
function renderUploadLogs() {
  const logs = listUploadLogs();
  app.innerHTML = `<section class="setup upload-log-view"><h1>上传日志</h1><p>上传日志仅保存在当前浏览器本地。清空日志不会删除云端照片。</p><div class="log-actions"><button id="back">返回相册</button><button id="clear-upload-logs" class="danger">清空上传日志</button></div><div class="upload-log-list">${logs.length ? logs.map(log => `<article class="upload-log-item ${esc(log.status)}"><div class="upload-log-head"><strong>${log.status === 'success' ? '成功' : log.status === 'failed' ? '失败' : '上传中'}</strong><span>${esc(formatDateTime(log.finishedAt || log.startedAt))}</span></div><p class="upload-log-name">${esc(log.fileName || '-')}</p><p>大小：${esc(formatSize(Number(log.fileSize)))}</p>${log.r2Key ? `<p>对象 Key：${esc(log.r2Key)}</p>` : ''}${log.error ? `<p class="upload-log-error">错误：${esc(log.error)}</p>` : ''}<p>开始：${esc(formatDateTime(log.startedAt))}</p><p>完成：${esc(formatDateTime(log.finishedAt))}</p></article>`).join('') : '<p class="empty">暂无上传日志，上传照片后会显示记录。</p>'}</div></section>`;
  document.querySelector('#back').onclick = render;
  document.querySelector('#clear-upload-logs').onclick = () => {
    if (!confirm('确定清空本地上传日志？该操作不会删除云端照片。')) return;
    clearUploadLogs();
    renderUploadLogs();
  };
}
function openViewer(photo, photos) {
  current = photos.indexOf(photo); app.insertAdjacentHTML('beforeend', `<dialog open id="viewer"><button id="close">×</button><div id="image-stage"><img alt="${esc(photo.name)}"></div><footer><button id="prev">‹</button><span>${esc(photo.name)} · ${Math.ceil(photo.size / 1024)} KB · ${format(photo.takenAt)}</span><button id="info">信息</button><button id="share">分享</button><button id="get">下载</button><button id="remove">删除</button><button id="next">›</button></footer></dialog>`);
  r2.get(photo.key).then(response => response.blob()).then(blob => { document.querySelector('#image-stage img').src = URL.createObjectURL(blob); }).catch(error => toast(`图片加载失败：${error.message}`, true));
  const dialog = document.querySelector('#viewer'), show = delta => { dialog.remove(); openViewer(photos[(current + delta + photos.length) % photos.length], photos); };
  document.querySelector('#close').onclick = () => dialog.remove(); document.querySelector('#prev').onclick = () => show(-1); document.querySelector('#next').onclick = () => show(1); document.querySelector('#get').onclick = () => download(photo);
  document.querySelector('#info').onclick = () => alert(`文件名：${photo.name}\n大小：${photo.size} 字节\n分辨率：${photo.dimensions || '未知'}\n拍摄时间：${format(photo.takenAt)}\n相册：${photo.album || '未分类'}\n对象：${photo.key}`);
  document.querySelector('#share').onclick = async () => { try { const blob = await (await r2.get(photo.key)).blob(); const file = new File([blob], photo.name, { type: blob.type }); if (navigator.canShare?.({ files: [file] })) await navigator.share({ title: photo.name, files: [file] }); else toast('当前浏览器不支持分享此文件。', true); } catch (e) { if (e.name !== 'AbortError') toast(`分享失败：${e.message}`, true); } };
  document.querySelector('#remove').onclick = async () => { selected = new Set([photo.id]); dialog.remove(); await action('delete'); };
  gesture(document.querySelector('#image-stage'), () => show(-1), () => show(1));
}
function gesture(stage, left, right) { let start, scale = 1; stage.onpointerdown = e => { start = e.clientX; stage.setPointerCapture(e.pointerId); }; stage.onpointerup = e => { if (Math.abs(e.clientX - start) > 60) e.clientX < start ? right() : left(); }; stage.ondblclick = () => { scale = scale === 1 ? 2 : 1; stage.querySelector('img').style.transform = `scale(${scale})`; }; }
async function imageDimensions(file) { try { const bitmap = await createImageBitmap(file); return `${bitmap.width} × ${bitmap.height}`; } catch { return ''; } }
async function receiveShared() { if (!location.search.includes('share-target')) return; const cached = await caches.open('cloud-album-shell-v1').then(c => c.match('./shared-files')); if (!cached) return; const files = await cached.json(); await caches.open('cloud-album-shell-v1').then(c => c.delete('./shared-files')); await upload(files.map(f => new File([new Uint8Array(f.data)], f.name, { type: f.type }))); history.replaceState(null, '', './'); }
function toast(message, error = false) { const node = document.querySelector('#toast'); if (node) { node.textContent = message; node.className = error ? 'error' : ''; } else console[error ? 'error' : 'log'](message); }
init();
