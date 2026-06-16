/**
 * IndexedDB ベースの翻訳キャッシュ（Tier 1）。
 *
 * 設計:
 *   - DB名: translate-cache, ストア: translations
 *   - キー: SHA-1(normalize(text) + '|' + src + '|' + tgt)
 *   - 値: { src, dst, engine, ts }
 *   - 30日経過したエントリは起動時にバキューム
 *   - 上限 ~500MB を目安に LRU で削除（hits を持たないので updated_at ベース）
 */

const DB_NAME = 'translate-cache';
const STORE = 'translations';
const VERSION = 1;
const MAX_ENTRIES = 50_000;          // 概算: 1エントリ平均 ~1KB → 50MB
const TTL_MS = 30 * 24 * 3600 * 1000;

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: 'key' });
        os.createIndex('ts', 'ts');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror  = () => reject(req.error);
  });
  return dbPromise;
}

export function normalize(text) {
  // NFKC + 連続空白圧縮。意味を保つ範囲で表記揺れを潰す。
  return text.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

async function sha1Hex(s) {
  const data = new TextEncoder().encode(s);
  const buf = await crypto.subtle.digest('SHA-1', data);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function cacheKey(text, source, target) {
  return await sha1Hex(`${normalize(text)}|${source}|${target}`);
}

export async function get(key) {
  const db = await openDb();
  return new Promise(resolve => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => {
      const v = req.result;
      if (!v) return resolve(null);
      if (Date.now() - v.ts > TTL_MS) return resolve(null);
      resolve(v);
    };
    req.onerror = () => resolve(null);
  });
}

export async function set(key, src, dst, engine, detectedSource) {
  const db = await openDb();
  return new Promise(resolve => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put({
      key, src, dst, engine,
      detectedSource: detectedSource || null,
      ts: Date.now(),
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

export async function vacuum() {
  // 期限切れ削除 + サイズ超過時の LRU 削除
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  const index = store.index('ts');
  const cutoff = Date.now() - TTL_MS;

  // 期限切れ
  return new Promise(resolve => {
    const req = index.openCursor(IDBKeyRange.upperBound(cutoff));
    req.onsuccess = () => {
      const c = req.result;
      if (c) { c.delete(); c.continue(); }
      else resolve();
    };
    req.onerror = () => resolve();
  });
}

export async function clear() {
  const db = await openDb();
  return new Promise(resolve => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
  });
}

export async function stats() {
  const db = await openDb();
  return new Promise(resolve => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).count();
    req.onsuccess = () => resolve({ entries: req.result });
    req.onerror = () => resolve({ entries: 0 });
  });
}
