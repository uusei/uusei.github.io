const KEY = 'upload-logs';

function readLogs() {
  try {
    const data = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function writeLogs(logs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(logs || []));
  } catch {}
}

export function createUploadLog({ fileName, fileSize, startedAt = new Date().toISOString() }) {
  const id = crypto.randomUUID();
  const logs = readLogs();
  logs.unshift({ id, fileName, fileSize, r2Key: '', status: 'uploading', error: '', startedAt, finishedAt: '' });
  writeLogs(logs);
  return id;
}

export function finishUploadLog(id, { status, r2Key = '', error = '', finishedAt = new Date().toISOString() }) {
  if (!id) return;
  const logs = readLogs();
  const target = logs.find(log => log.id === id);
  if (!target) return;
  target.status = status;
  target.r2Key = r2Key;
  target.error = error;
  target.finishedAt = finishedAt;
  writeLogs(logs);
}

export function listUploadLogs() {
  return readLogs();
}

export function clearUploadLogs() {
  localStorage.removeItem(KEY);
}
