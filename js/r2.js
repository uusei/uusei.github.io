const encoder = new TextEncoder();
const hash = async data => [...new Uint8Array(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? encoder.encode(data) : data))].map(x => x.toString(16).padStart(2, '0')).join('');
const hmac = async (key, value) => crypto.subtle.sign('HMAC', await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), encoder.encode(value)).then(x => new Uint8Array(x));
const hex = bytes => [...bytes].map(x => x.toString(16).padStart(2, '0')).join('');
const xml = (text, tag) => [...new DOMParser().parseFromString(text, 'application/xml').getElementsByTagName(tag)].map(n => n.textContent);

export class R2 {
  constructor(config) { this.config = config; this.endpoint = `https://${config.accountId}.r2.cloudflarestorage.com`; }
  async request(method, key = '', { query = {}, body, headers = {}, onProgress } = {}) {
    const { accessKeyId, secretAccessKey, bucket } = this.config;
    const now = new Date(), stamp = now.toISOString().replace(/[:-]|\.\d{3}/g, ''), date = stamp.slice(0, 8);
    const path = `/${bucket}${key ? `/${key.split('/').map(encodeURIComponent).join('/')}` : ''}`;
    const params = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined).map(([k, v]) => [k, v]));
    const canonicalQuery = [...params].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
    const payload = body ? (body instanceof Blob ? await body.arrayBuffer() : body) : new ArrayBuffer(0);
    const payloadHash = await hash(payload);
    const allHeaders = { host: new URL(this.endpoint).host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': stamp, ...headers };
    const signedHeaders = Object.keys(allHeaders).map(x => x.toLowerCase()).sort();
    const canonicalHeaders = signedHeaders.map(k => `${k}:${String(allHeaders[k] ?? allHeaders[Object.keys(allHeaders).find(x => x.toLowerCase() === k)]).trim()}\n`).join('');
    const canonical = [method, path, canonicalQuery, canonicalHeaders, signedHeaders.join(';'), payloadHash].join('\n');
    const scope = `${date}/auto/s3/aws4_request`;
    const stringToSign = `AWS4-HMAC-SHA256\n${stamp}\n${scope}\n${await hash(canonical)}`;
    let signingKey = await hmac(encoder.encode(`AWS4${secretAccessKey}`), date);
    for (const part of ['auto', 's3', 'aws4_request']) signingKey = await hmac(signingKey, part);
    allHeaders.Authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders.join(';')}, Signature=${hex(await hmac(signingKey, stringToSign))}`;
    const url = `${this.endpoint}${path}${canonicalQuery ? `?${canonicalQuery}` : ''}`;
    const response = await fetch(url, { method, headers: allHeaders, body: body ? (onProgress ? progressBody(body, onProgress) : body) : undefined, ...(onProgress ? { duplex: 'half' } : {}) });
    if (!response.ok) throw new Error(`${response.status}：${await response.text()}`);
    return response;
  }
  async list(prefix = '', token) { const r = await this.request('GET', '', { query: { 'list-type': '2', prefix, 'continuation-token': token } }); const text = await r.text(); return { keys: xml(text, 'Key'), token: xml(text, 'NextContinuationToken')[0] }; }
  get(key) { return this.request('GET', key); }
  put(key, file, onProgress) { return this.request('PUT', key, { body: file, headers: { 'content-type': file.type || 'application/octet-stream' }, onProgress }); }
  delete(key) { return this.request('DELETE', key); }
  copy(from, to) { return this.request('PUT', to, { headers: { 'x-amz-copy-source': `/${this.config.bucket}/${from.split('/').map(encodeURIComponent).join('/')}` } }); }
}
function progressBody(blob, callback) {
  let sent = 0;
  return new ReadableStream({ async pull(controller) { const chunk = await blob.slice(sent, Math.min(sent + 64 * 1024, blob.size)).arrayBuffer(); if (!chunk.byteLength) return controller.close(); sent += chunk.byteLength; callback(sent, blob.size); controller.enqueue(new Uint8Array(chunk)); } });
}
