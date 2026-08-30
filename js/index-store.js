const DB = 'cloud-album', STORE = 'state';
const db = () => new Promise((resolve, reject) => { const req = indexedDB.open(DB, 1); req.onupgradeneeded = () => req.result.createObjectStore(STORE); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
async function local(key, value) { const d = await db(); return new Promise((resolve, reject) => { const tx = d.transaction(STORE, value === undefined ? 'readonly' : 'readwrite'); const req = value === undefined ? tx.objectStore(STORE).get(key) : tx.objectStore(STORE).put(value, key); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); }); }

/**
 * 本地配置存储（包含 R2 凭据与自定义图片外链 Base URL）
 */
export const config = {
  get: () => JSON.parse(localStorage.getItem('r2-config') || 'null'),
  set: value => localStorage.setItem('r2-config', JSON.stringify(value)),
  clear: () => localStorage.removeItem('r2-config'),
  // 获取图片 Base URL
  getImgBaseUrl: () => (localStorage.getItem('IMG_BASE_URL') || '').trim().replace(/\/+$/, ''),
  // 保存或清除图片 Base URL
  setImgBaseUrl: value => {
    const normalized = String(value || '').trim().replace(/\/+$/, '');
    if (normalized) {
      localStorage.setItem('IMG_BASE_URL', normalized);
    } else {
      localStorage.removeItem('IMG_BASE_URL');
    }
    return normalized;
  },
  // 清除图片 Base URL
  clearImgBaseUrl: () => localStorage.removeItem('IMG_BASE_URL')
};

export async function loadIndex(r2) { try { const index = await (await r2.get('meta/index.json')).json(); await local('index', index); return index; } catch (error) { const cached = await local('index'); if (cached) return cached; if (String(error).startsWith('Error: 404')) return { photos: [], albums: [] }; throw error; } }
export async function saveIndex(r2, index) { index.updatedAt = new Date().toISOString(); await r2.put('meta/index.json', new Blob([JSON.stringify(index)], { type: 'application/json' })); await local('index', index); }
export async function thumbnail(file) { const bitmap = await createImageBitmap(file); const scale = Math.min(1, 400 / Math.max(bitmap.width, bitmap.height)); const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale)); canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height); return canvas.convertToBlob({ type: 'image/webp', quality: .8 }); }
