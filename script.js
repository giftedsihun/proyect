/* Secure Message: 모든 처리와 저장은 브라우저 안에서만 수행됩니다. */
const $ = (selector) => document.querySelector(selector);
const encoder = new TextEncoder();
const decoder = new TextDecoder();
// 브라우저 메모리에서 원본·압축본·암호문을 함께 다루므로 25MB로 제한합니다.
const MAX_SIZE = 25 * 1024 * 1024;
// Supabase Project Settings > API의 URL과 anon public key만 넣으세요. service_role 키는 절대 넣지 마세요.
const SUPABASE_CONFIG = { url: 'https://jucjidicqkoomcismvjs.supabase.co', anonKey: 'sb_publishable_pcAOkT6I2k4JXkMMRa7YZg_IcOUgzl_', bucket: 'encrypted-packages' };
let encryptedPackage = null;
let restoredFile = null;
let analysisData = null;

function bytesLabel(size) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(2)} MB`;
}
function supabaseReady() { return SUPABASE_CONFIG.url.startsWith('https://') && SUPABASE_CONFIG.anonKey.length > 20; }
function supabaseHeaders(extra = {}) { return { apikey: SUPABASE_CONFIG.anonKey, Authorization: `Bearer ${SUPABASE_CONFIG.anonKey}`, ...extra }; }
async function supabaseRequest(path, options = {}) {
  const response = await fetch(`${SUPABASE_CONFIG.url}${path}`, { ...options, headers: supabaseHeaders(options.headers) });
  if (!response.ok) { let detail = ''; try { detail = (await response.json()).message || ''; } catch { detail = await response.text(); } throw new Error(detail || `서버 요청에 실패했습니다. (${response.status})`); }
  return response;
}

function setStatus(id, message, kind = '') {
  const element = $(id);
  element.textContent = message;
  element.className = `status ${kind}`;
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c])); }
function printableByte(byte) { return byte >= 32 && byte <= 126 ? `'${String.fromCharCode(byte)}'` : `0x${byte.toString(16).padStart(2, '0').toUpperCase()}`; }

// 트리: 최소 힙 우선순위 큐로 가장 적은 빈도의 두 노드를 반복 결합합니다.
class MinHeap {
  constructor() { this.items = []; }
  push(item) { this.items.push(item); this.bubble(this.items.length - 1); }
  bubble(index) { while (index) { const parent = (index - 1) >> 1; if (this.items[parent].freq <= this.items[index].freq) break; [this.items[parent], this.items[index]] = [this.items[index], this.items[parent]]; index = parent; } }
  pop() { if (!this.items.length) return null; const root = this.items[0]; const last = this.items.pop(); if (this.items.length) { this.items[0] = last; this.sink(0); } return root; }
  sink(index) { while (true) { let smallest = index; const left = index * 2 + 1, right = left + 1; if (left < this.items.length && this.items[left].freq < this.items[smallest].freq) smallest = left; if (right < this.items.length && this.items[right].freq < this.items[smallest].freq) smallest = right; if (smallest === index) break; [this.items[index], this.items[smallest]] = [this.items[smallest], this.items[index]]; index = smallest; } }
  get length() { return this.items.length; }
}

function frequencyTable(bytes) { const frequencies = new Uint32Array(256); for (const byte of bytes) frequencies[byte]++; return frequencies; }
function buildHuffman(frequencies) {
  const heap = new MinHeap(); let order = 0;
  frequencies.forEach((freq, byte) => { if (freq) heap.push({ freq, byte, order: order++ }); });
  if (!heap.length) return null;
  while (heap.length > 1) { const left = heap.pop(), right = heap.pop(); heap.push({ freq: left.freq + right.freq, left, right, order: order++ }); }
  return heap.pop();
}
function makeCodes(root) {
  const codes = new Array(256);
  const walk = (node, path) => { if ('byte' in node) { codes[node.byte] = path || '0'; return; } walk(node.left, `${path}0`); walk(node.right, `${path}1`); };
  walk(root, ''); return codes;
}
function compressHuffman(bytes, codes) {
  let bitLength = 0; for (const byte of bytes) bitLength += codes[byte].length;
  const packed = new Uint8Array(Math.ceil(bitLength / 8)); let position = 0;
  for (const byte of bytes) for (const bit of codes[byte]) { if (bit === '1') packed[position >> 3] |= 1 << (7 - (position & 7)); position++; }
  return { packed, bitLength };
}
function decompressHuffman(packed, bitLength, root, expectedLength) {
  if ('byte' in root) return new Uint8Array(expectedLength).fill(root.byte);
  const output = new Uint8Array(expectedLength); let node = root, outputIndex = 0;
  for (let position = 0; position < bitLength; position++) { node = ((packed[position >> 3] >> (7 - (position & 7))) & 1) ? node.right : node.left; if ('byte' in node) { if (outputIndex >= expectedLength) throw new Error('압축 데이터 형식이 올바르지 않습니다.'); output[outputIndex++] = node.byte; node = root; } }
  if (outputIndex !== expectedLength || node !== root) throw new Error('압축 데이터가 완전하지 않습니다.');
  return output;
}

const PBKDF2_ITERATIONS = 250000;
const AES_SALT_LENGTH = 16;
const AES_IV_LENGTH = 12;

// 학습 모드용 XOR은 기존 SME1 패키지를 읽을 때도 유지합니다.
function xorBytes(data, key) { const result = new Uint8Array(data.length); for (let i = 0; i < data.length; i++) result[i] = data[i] ^ key[i % key.length]; return result; }
async function deriveLegacyKey(password) { return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(password))); }
async function deriveAesKey(password, salt, iterations = PBKDF2_ITERATIONS) {
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
function randomBytes(length) { const bytes = new Uint8Array(length); crypto.getRandomValues(bytes); return bytes; }
async function sha256(data) { return new Uint8Array(await crypto.subtle.digest('SHA-256', data)); }
function hex(bytes) { return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(''); }
function equalBytes(a, b) { return a.length === b.length && a.every((value, index) => value === b[index]); }

function makeLegacyPackage(meta, frequencies, bitLength, encrypted, integrity) {
  const name = encoder.encode(meta.name), mime = encoder.encode(meta.mime || 'application/octet-stream');
  const headerLength = 4 + 2 + 2 + 4 + 4 + 256 * 4 + 32 + name.length + mime.length;
  const output = new Uint8Array(headerLength + encrypted.length), view = new DataView(output.buffer);
  output.set([0x53, 0x4d, 0x45, 0x31]); let offset = 4;
  view.setUint16(offset, name.length); offset += 2; view.setUint16(offset, mime.length); offset += 2;
  view.setUint32(offset, meta.size); offset += 4; view.setUint32(offset, bitLength); offset += 4;
  frequencies.forEach((freq, index) => view.setUint32(offset + index * 4, freq)); offset += 256 * 4;
  output.set(integrity, offset); offset += 32; output.set(name, offset); offset += name.length; output.set(mime, offset); offset += mime.length; output.set(encrypted, offset);
  return output;
}
function makeAesHeader(meta, frequencies, bitLength, salt, iv) {
  const name = encoder.encode(meta.name), mime = encoder.encode(meta.mime || 'application/octet-stream');
  const headerLength = 4 + 2 + 2 + 4 + 4 + 4 + AES_SALT_LENGTH + AES_IV_LENGTH + 256 * 4 + name.length + mime.length;
  const header = new Uint8Array(headerLength), view = new DataView(header.buffer);
  header.set([0x53, 0x4d, 0x45, 0x32]); let offset = 4;
  view.setUint16(offset, name.length); offset += 2; view.setUint16(offset, mime.length); offset += 2;
  view.setUint32(offset, meta.size); offset += 4; view.setUint32(offset, bitLength); offset += 4; view.setUint32(offset, PBKDF2_ITERATIONS); offset += 4;
  header.set(salt, offset); offset += AES_SALT_LENGTH; header.set(iv, offset); offset += AES_IV_LENGTH;
  frequencies.forEach((freq, index) => view.setUint32(offset + index * 4, freq)); offset += 256 * 4;
  header.set(name, offset); offset += name.length; header.set(mime, offset);
  return header;
}
function makeAesPackage(header, encrypted) { const output = new Uint8Array(header.length + encrypted.length); output.set(header); output.set(encrypted, header.length); return output; }
function parseLegacyPackage(bytes) {
  if (bytes.length < 1072 || String.fromCharCode(...bytes.slice(0, 4)) !== 'SME1') throw new Error('지원하지 않는 보안 패키지입니다.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); let offset = 4;
  const nameLength = view.getUint16(offset); offset += 2; const mimeLength = view.getUint16(offset); offset += 2;
  const originalSize = view.getUint32(offset); offset += 4; const bitLength = view.getUint32(offset); offset += 4;
  if (originalSize > MAX_SIZE || bitLength > MAX_SIZE * 16 || offset + 1024 + 32 + nameLength + mimeLength > bytes.length) throw new Error('파일 헤더가 올바르지 않거나 지원 크기를 초과합니다.');
  const frequencies = new Uint32Array(256); for (let i = 0; i < 256; i++) frequencies[i] = view.getUint32(offset + i * 4); offset += 1024;
  const integrity = bytes.slice(offset, offset + 32); offset += 32;
  const name = decoder.decode(bytes.slice(offset, offset + nameLength)); offset += nameLength;
  const mime = decoder.decode(bytes.slice(offset, offset + mimeLength)); offset += mimeLength;
  const encrypted = bytes.slice(offset);
  if (!encrypted.length || !frequencies.some(Boolean)) throw new Error('암호화된 본문이 없습니다.');
  return { version: 'SME1', name, mime, originalSize, bitLength, frequencies, integrity, encrypted };
}
function parseAesPackage(bytes) {
  const minimumLength = 4 + 2 + 2 + 4 + 4 + 4 + AES_SALT_LENGTH + AES_IV_LENGTH + 1024 + 16;
  if (bytes.length < minimumLength || String.fromCharCode(...bytes.slice(0, 4)) !== 'SME2') throw new Error('지원하지 않는 보안 패키지입니다.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); let offset = 4;
  const nameLength = view.getUint16(offset); offset += 2; const mimeLength = view.getUint16(offset); offset += 2;
  const originalSize = view.getUint32(offset); offset += 4; const bitLength = view.getUint32(offset); offset += 4; const iterations = view.getUint32(offset); offset += 4;
  if (originalSize > MAX_SIZE || bitLength > MAX_SIZE * 16 || iterations < 100000 || iterations > 1000000 || offset + AES_SALT_LENGTH + AES_IV_LENGTH + 1024 + nameLength + mimeLength + 16 > bytes.length) throw new Error('파일 헤더가 올바르지 않거나 지원 크기를 초과합니다.');
  const salt = bytes.slice(offset, offset + AES_SALT_LENGTH); offset += AES_SALT_LENGTH; const iv = bytes.slice(offset, offset + AES_IV_LENGTH); offset += AES_IV_LENGTH;
  const frequencies = new Uint32Array(256); for (let i = 0; i < 256; i++) frequencies[i] = view.getUint32(offset + i * 4); offset += 1024;
  const name = decoder.decode(bytes.slice(offset, offset + nameLength)); offset += nameLength; const mime = decoder.decode(bytes.slice(offset, offset + mimeLength)); offset += mimeLength;
  const encrypted = bytes.slice(offset);
  if (!frequencies.some(Boolean)) throw new Error('압축 정보가 없습니다.');
  return { version: 'SME2', name, mime, originalSize, bitLength, iterations, salt, iv, frequencies, encrypted, aad: bytes.slice(0, offset) };
}
function parsePackage(bytes) {
  const magic = String.fromCharCode(...bytes.slice(0, 4));
  if (magic === 'SME2') return parseAesPackage(bytes);
  if (magic === 'SME1') return parseLegacyPackage(bytes);
  throw new Error('Secure Message .enc 파일이 아닙니다.');
}

function setProcess(id, state) { const element = $(id); element.classList.remove('working', 'done'); if (state) element.classList.add(state); element.querySelector('i').textContent = state === 'done' ? '●' : state === 'working' ? '◌' : '○'; }
function updateSteps(container, count) { [...container.querySelectorAll('.step')].forEach((step, index) => step.classList.toggle('active', index < count)); }
function sourceFromInput() {
  const file = $('#sourceFile').files[0]; const text = $('#messageInput').value;
  if (file) return file.size > MAX_SIZE ? Promise.reject(new Error('파일은 25MB 이하만 사용할 수 있습니다.')) : file.arrayBuffer().then((buffer) => ({ bytes: new Uint8Array(buffer), name: file.name, mime: file.type || 'application/octet-stream' }));
  if (!text.trim()) return Promise.reject(new Error('텍스트를 입력하거나 파일을 선택하세요.'));
  return Promise.resolve({ bytes: encoder.encode(text), name: 'secure-message.txt', mime: 'text/plain;charset=utf-8' });
}
function loadDemoMessage() {
  $('#sourceFile').value = '';
  $('#messageInput').value = '이산수학으로 안전하게 보낸 메시지입니다.\n\n허프만 트리는 자주 반복되는 데이터를 더 짧게 표현합니다.\n허프만 트리는 자주 반복되는 데이터를 더 짧게 표현합니다.\n허프만 트리는 자주 반복되는 데이터를 더 짧게 표현합니다.\n\nXOR 비트 연산과 바이트 분포도 함께 확인해 보세요.';
  $('#encryptKey').value = 'MATH-2026';
  $('#sourceMeta').textContent = '발표용 예시 텍스트 · 반복 데이터 포함 · 키: MATH-2026';
  setStatus('#encryptStatus', '발표용 예시를 불러왔습니다. 암호화 후 트리와 압축률을 확인하세요.', 'success');
}
function updateEncryptionMode() {
  const isAes = $('#encryptionMode').value === 'aes';
  $('#modeNotice').innerHTML = isAes
    ? '<b>권장 모드</b> 매 암호화마다 새 salt와 IV를 만들고, AES-GCM으로 암호화와 변조 검증을 함께 수행합니다.'
    : '<b>학습 모드</b> SHA-256 결과를 반복 XOR합니다. 같은 키의 반복 사용과 키 추측에 취약하므로 실제 파일 보호에는 사용하지 마세요.';
  $('#keyProcessTitle').textContent = isAes ? 'PBKDF2 키 유도' : 'SHA-256 키 재료 생성';
  $('#keyProcessDetail').textContent = isAes ? '비밀 키 + random salt → AES-256 키' : '입력 키 → 32바이트 키 재료';
  $('#cipherProcessTitle').textContent = isAes ? 'AES-GCM 인증 암호화' : 'XOR 암호화 (학습용)';
  $('#cipherProcessDetail').textContent = isAes ? 'random IV · 암호화와 변조 검증' : '압축 데이터 ⊕ 반복 키 재료';
}

async function encrypt() {
  const button = $('#encryptButton'), keyText = $('#encryptKey').value, mode = $('#encryptionMode').value;
  if (!keyText) return setStatus('#encryptStatus', '비밀 키를 입력하세요.', 'error');
  button.disabled = true; $('#resultBox').classList.add('hidden');
  try {
    const source = await sourceFromInput(); if (!source.bytes.length) throw new Error('빈 데이터는 암호화할 수 없습니다.');
    setStatus('#encryptStatus', '바이트 빈도를 계산하고 허프만 트리를 생성하는 중...'); setProcess('#processHuffman', 'working'); updateSteps($('#encrypt .steps'), 2); await sleep(250);
    const frequencies = frequencyTable(source.bytes), root = buildHuffman(frequencies), codes = makeCodes(root), compressed = compressHuffman(source.bytes, codes);
    renderTree(root, codes); setProcess('#processHuffman', 'done'); $('#treeNote').textContent = `${frequencies.filter(Boolean).length}개 바이트 종류 · ${compressed.bitLength.toLocaleString()} bits`;
    let encrypted, packageVersion;
    setProcess('#processHash', 'working'); updateSteps($('#encrypt .steps'), 3);
    if (mode === 'aes') {
      const salt = randomBytes(AES_SALT_LENGTH), iv = randomBytes(AES_IV_LENGTH);
      setStatus('#encryptStatus', `PBKDF2-SHA-256 ${PBKDF2_ITERATIONS.toLocaleString()}회로 AES-256 키를 유도하는 중...`);
      const key = await deriveAesKey(keyText, salt); $('#hashDisplay code').textContent = `비밀 키 + salt ${hex(salt).slice(0, 12)}... → PBKDF2-SHA-256 (${PBKDF2_ITERATIONS.toLocaleString()}회) → AES-256`; setProcess('#processHash', 'done');
      setStatus('#encryptStatus', '새 IV로 AES-GCM 인증 암호화를 적용하는 중...'); setProcess('#processXor', 'working');
      const header = makeAesHeader({ ...source, size: source.bytes.length }, frequencies, compressed.bitLength, salt, iv);
      encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: header, tagLength: 128 }, key, compressed.packed));
      encryptedPackage = makeAesPackage(header, encrypted); packageVersion = 'SME2 / AES-256-GCM';
    } else {
      setStatus('#encryptStatus', 'SHA-256으로 학습용 XOR 키 재료를 만드는 중...');
      const key = await deriveLegacyKey(keyText); $('#hashDisplay code').textContent = `${keyText} → SHA-256 → ${hex(key).slice(0, 32)}... (학습용 32 bytes)`; setProcess('#processHash', 'done');
      setStatus('#encryptStatus', '압축 데이터에 학습용 XOR 연산을 적용하는 중...'); setProcess('#processXor', 'working');
      encrypted = xorBytes(compressed.packed, key); encryptedPackage = makeLegacyPackage({ ...source, size: source.bytes.length }, frequencies, compressed.bitLength, encrypted, await sha256(source.bytes)); packageVersion = 'SME1 / LEGACY XOR';
    }
    setProcess('#processXor', 'done'); setProcess('#processReady', 'done'); updateSteps($('#encrypt .steps'), 4);
    const ratio = (1 - compressed.packed.length / source.bytes.length) * 100;
    $('#compressionText').textContent = `${bytesLabel(source.bytes.length)} → ${bytesLabel(compressed.packed.length)} (${ratio >= 0 ? ratio.toFixed(1) : '+' + Math.abs(ratio).toFixed(1)}%)`;
    $('#packageSize').textContent = `${bytesLabel(encryptedPackage.length)} · ${packageVersion}`; $('#resultBox').classList.remove('hidden'); $('#uploadBox').classList.remove('hidden');
    const legacyKey = await deriveLegacyKey(keyText); analysisData = { original: source.bytes, encrypted, cipherLabel: mode === 'aes' ? 'AES-GCM 암호문' : 'SHA-256 XOR 암호문', simple: xorBytes(compressed.packed, encoder.encode(keyText)), hashed: xorBytes(compressed.packed, legacyKey) }; renderAnalysis();
    setStatus('#encryptStatus', mode === 'aes' ? '완료! AES-GCM 인증 암호문 .enc 파일을 다운로드해 전달하세요.' : '완료! 학습용 XOR .enc 파일을 만들었습니다. 실제 보호에는 AES-GCM 모드를 사용하세요.', mode === 'aes' ? 'success' : 'error');
  } catch (error) { setStatus('#encryptStatus', error.message, 'error'); }
  button.disabled = false;
}

function makeShareId() { return crypto.randomUUID(); }
function formatTime(value) { return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)); }
async function uploadEncryptedPackage() {
  if (!encryptedPackage) return setStatus('#uploadStatus', '먼저 암호화를 완료하세요.', 'error');
  if (!supabaseReady()) return setStatus('#uploadStatus', 'Supabase 설정이 필요합니다. supabase-setup.md를 확인하세요.', 'error');
  const button = $('#uploadEnc'), id = makeShareId(), path = `${id}.enc`, hours = Number($('#expiryHours').value), senderName = $('#senderName').value.trim() || '익명';
  button.disabled = true; setStatus('#uploadStatus', '암호문 패키지를 서버에 업로드하는 중...');
  try {
    await supabaseRequest(`/storage/v1/object/${SUPABASE_CONFIG.bucket}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'x-upsert': 'false' }, body: encryptedPackage });
    const metadata = { id, sender_name: senderName, original_name: 'secure-message.enc', package_size: encryptedPackage.length, storage_path: path, expires_at: new Date(Date.now() + hours * 3600000).toISOString() };
    try { await supabaseRequest('/rest/v1/secure_messages', { method: 'POST', headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify(metadata) }); } catch (error) { await supabaseRequest(`/storage/v1/object/${SUPABASE_CONFIG.bucket}/${path}`, { method: 'DELETE' }).catch(() => {}); throw error; }
    setStatus('#uploadStatus', `업로드 완료. 공유 ID: ${id.slice(0, 8)} · ${metadata.expires_at.slice(0, 10)}까지 보관`, 'success');
  } catch (error) { setStatus('#uploadStatus', error.message, 'error'); }
  button.disabled = false;
}
async function loadInbox() {
  if (!supabaseReady()) return setStatus('#inboxStatus', 'Supabase URL과 anon public key를 script.js에 설정하세요. 설정 방법은 supabase-setup.md에 있습니다.', 'error');
  setStatus('#inboxStatus', '공유된 암호문을 불러오는 중...'); $('#inboxList').innerHTML = '<div class="inbox-empty">암호문 목록을 불러오는 중입니다...</div>';
  try {
    const response = await supabaseRequest('/rest/v1/secure_messages?select=id,sender_name,original_name,package_size,storage_path,expires_at,created_at&order=created_at.desc'); const messages = await response.json();
    if (!messages.length) { $('#inboxList').innerHTML = '<div class="inbox-empty">현재 보관된 암호문이 없습니다.</div>'; return setStatus('#inboxStatus', '만료되지 않은 암호문 0개', 'success'); }
    $('#inboxList').innerHTML = messages.map((message) => `<div class="inbox-item"><div><strong>${escapeHtml(message.original_name)}</strong><small>보낸 사람: ${escapeHtml(message.sender_name)} · ID ${message.id.slice(0, 8)}</small></div><span>${bytesLabel(message.package_size)}</span><span>만료: ${formatTime(message.expires_at)}</span><button class="secondary-button" data-download-id="${message.id}">받아서 복호화 <b>↓</b></button></div>`).join('');
    $('#inboxList').querySelectorAll('[data-download-id]').forEach((button) => button.addEventListener('click', () => downloadSharedPackage(messages.find((message) => message.id === button.dataset.downloadId), button)));
    setStatus('#inboxStatus', `만료되지 않은 암호문 ${messages.length}개를 불러왔습니다.`, 'success');
  } catch (error) { $('#inboxList').innerHTML = '<div class="inbox-empty">보관함을 불러오지 못했습니다.</div>'; setStatus('#inboxStatus', error.message, 'error'); }
}
async function downloadSharedPackage(message, button) {
  button.disabled = true; button.textContent = '가져오는 중...';
  try {
    const response = await supabaseRequest(`/storage/v1/object/${SUPABASE_CONFIG.bucket}/${message.storage_path}`); const blob = await response.blob(); const file = new File([blob], message.original_name, { type: 'application/octet-stream' }); const transfer = new DataTransfer(); transfer.items.add(file); $('#encryptedFile').files = transfer.files; $('#encryptedMeta').textContent = `${message.original_name} · ${bytesLabel(file.size)} · 공유 보관함에서 수신`; document.querySelector('[data-tab="decrypt"]').click(); setStatus('#decryptStatus', '공유 보관함의 암호문을 불러왔습니다. 비밀 키를 입력해 복호화하세요.', 'success');
  } catch (error) { setStatus('#inboxStatus', error.message, 'error'); button.disabled = false; button.innerHTML = '받아서 복호화 <b>↓</b>'; }
}

function renderTree(root, codes) {
  const leaves = []; const collect = (node, depth = 0) => { if ('byte' in node) leaves.push({ node, depth }); else { collect(node.left, depth + 1); collect(node.right, depth + 1); } }; collect(root);
  const width = Math.max(700, leaves.length * 76), height = Math.max(280, (Math.max(...leaves.map((x) => x.depth)) + 1) * 67); let leafIndex = 0;
  const positions = new Map(); const place = (node, depth = 0) => { const y = 34 + depth * 67; if ('byte' in node) { const pos = { x: 38 + leafIndex++ * ((width - 76) / Math.max(1, leaves.length - 1)), y }; positions.set(node, pos); return pos; } const left = place(node.left, depth + 1), right = place(node.right, depth + 1), pos = { x: (left.x + right.x) / 2, y }; positions.set(node, pos); return pos; }; place(root);
  let lines = '', nodes = ''; const draw = (node) => { const p = positions.get(node); if (!('byte' in node)) { for (const [child, label] of [[node.left, '0'], [node.right, '1']]) { const c = positions.get(child); lines += `<line x1="${p.x}" y1="${p.y + 13}" x2="${c.x}" y2="${c.y - 13}"/><text class="edge-label" x="${(p.x + c.x) / 2 + 4}" y="${(p.y + c.y) / 2 - 4}">${label}</text>`; draw(child); } } const label = 'byte' in node ? printableByte(node.byte) : node.freq; nodes += `<circle class="node ${'byte' in node ? 'leaf' : ''}" cx="${p.x}" cy="${p.y}" r="${'byte' in node ? 20 : 15}"/><text class="node-label" x="${p.x}" y="${p.y}">${escapeHtml(label)}</text>`; }; draw(root);
  $('#treeViewport').innerHTML = `<svg class="tree-svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" aria-label="허프만 트리">${lines}${nodes}</svg>`;
  $('#codeLegend').innerHTML = codes.map((code, byte) => code ? `<span class="code-token">${escapeHtml(printableByte(byte))} → ${code}</span>` : '').join('');
}

async function decrypt() {
  const file = $('#encryptedFile').files[0], keyText = $('#decryptKey').value, button = $('#decryptButton');
  if (!file) return setStatus('#decryptStatus', '.enc 파일을 선택하세요.', 'error'); if (!keyText) return setStatus('#decryptStatus', '암호화에 사용한 비밀 키를 입력하세요.', 'error'); if (file.size > MAX_SIZE + 140000) return setStatus('#decryptStatus', '지원 크기(원본 25MB)를 초과한 파일입니다.', 'error');
  button.disabled = true; try {
    setStatus('#decryptStatus', '보안 패키지를 읽는 중...'); const pack = parsePackage(new Uint8Array(await file.arrayBuffer())); updateSteps($('#decrypt .steps'), 2);
    let compressed, verification;
    if (pack.version === 'SME2') {
      setStatus('#decryptStatus', `PBKDF2-SHA-256 ${pack.iterations.toLocaleString()}회로 키를 유도하고 AES-GCM 인증을 검증하는 중...`);
      const key = await deriveAesKey(keyText, pack.salt, pack.iterations);
      try { compressed = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: pack.iv, additionalData: pack.aad, tagLength: 128 }, key, pack.encrypted)); } catch { throw new Error('AES-GCM 인증 검증에 실패했습니다. 비밀 키가 틀렸거나 파일 또는 헤더가 변경되었습니다.'); }
      verification = 'AES-GCM AUTHENTICATED';
    } else {
      setStatus('#decryptStatus', '학습용 SME1 패키지를 SHA-256 반복 XOR로 복호화하는 중...');
      compressed = xorBytes(pack.encrypted, await deriveLegacyKey(keyText)); verification = 'LEGACY SHA-256 VERIFIED';
    }
    updateSteps($('#decrypt .steps'), 3); setStatus('#decryptStatus', '허프만 트리로 원본을 복원하는 중...'); const output = decompressHuffman(compressed, pack.bitLength, buildHuffman(pack.frequencies), pack.originalSize);
    if (pack.version === 'SME1' && !equalBytes(await sha256(output), pack.integrity)) throw new Error('무결성 검증에 실패했습니다. 키가 틀렸거나 파일이 손상되었습니다.');
    restoredFile = { bytes: output, name: pack.name || 'restored-file', mime: pack.mime }; $('#recoveryEmpty').classList.add('hidden'); $('#recoveryResult').classList.remove('hidden'); $('#restoredInfo').textContent = `RESTORED / ${pack.name} / ${bytesLabel(output.length)} / ${verification}`;
    const isText = pack.mime.startsWith('text/') || /\.(txt|csv|json|md|html|js|css)$/i.test(pack.name); $('#restoredText').classList.toggle('hidden', !isText); if (isText) $('#restoredText').textContent = decoder.decode(output); updateSteps($('#decrypt .steps'), 4); setStatus('#decryptStatus', pack.version === 'SME2' ? '복원 완료! AES-GCM 인증 검증을 통과했습니다.' : '복원 완료! 학습용 SME1 XOR 패키지의 SHA-256 검증을 통과했습니다.', 'success');
  } catch (error) { updateSteps($('#decrypt .steps'), 1); setStatus('#decryptStatus', error.message || '복호화에 실패했습니다. 키를 확인하세요.', 'error'); }
  button.disabled = false;
}

// 그래프: 0~255 바이트 값의 빈도를 직접 Canvas 막대그래프로 그립니다.
function drawDistribution(canvasId, datasets) {
  const canvas = $(canvasId), ratio = window.devicePixelRatio || 1, width = canvas.clientWidth, height = canvas.clientHeight; canvas.width = width * ratio; canvas.height = height * ratio; const ctx = canvas.getContext('2d'); ctx.scale(ratio, ratio); ctx.clearRect(0, 0, width, height);
  const counts = datasets.map((set) => frequencyTable(set.data)); const max = Math.max(1, ...counts.flatMap((table) => Array.from(table))); const pad = { left: 36, right: 12, top: 27, bottom: 28 }, graphW = width - pad.left - pad.right, graphH = height - pad.top - pad.bottom;
  ctx.strokeStyle = 'rgba(160,210,221,.16)'; ctx.fillStyle = '#7693a0'; ctx.font = '10px DM Mono'; for (let n = 0; n <= 4; n++) { const y = pad.top + graphH * n / 4; ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(width - pad.right, y); ctx.stroke(); if (n < 4) ctx.fillText(Math.round(max * (1 - n / 4)).toString(), 2, y + 3); }
  const barWidth = graphW / 256; counts.forEach((table, setIndex) => { ctx.fillStyle = datasets[setIndex].color; for (let i = 0; i < 256; i++) { const h = table[i] / max * graphH; ctx.fillRect(pad.left + i * barWidth + (setIndex ? barWidth * .42 : 0), pad.top + graphH - h, Math.max(.7, barWidth * .46), h); } });
  ctx.fillStyle = '#7693a0'; [0, 64, 128, 192, 255].forEach((value) => ctx.fillText(value, pad.left + graphW * value / 255 - 5, height - 9)); let legendX = pad.left; datasets.forEach((set) => { ctx.fillStyle = set.color; ctx.fillRect(legendX, 9, 8, 8); ctx.fillStyle = '#c5dcda'; ctx.fillText(set.label, legendX + 12, 16); legendX += ctx.measureText(set.label).width + 32; });
}
function renderAnalysis() { if (!analysisData) return; $('#analysisEmpty').classList.add('hidden'); $('#analysisContent').classList.remove('hidden'); requestAnimationFrame(() => { drawDistribution('#mainDistribution', [{ label: '원본', data: analysisData.original, color: '#e9c76d' }, { label: analysisData.cipherLabel, data: analysisData.encrypted, color: '#55e6cf' }]); drawDistribution('#keyDistribution', [{ label: '단순 반복 키', data: analysisData.simple, color: '#ff7e72' }, { label: 'SHA-256 확장 키', data: analysisData.hashed, color: '#55e6cf' }]); }); }
function download(bytes, name, mime) { const url = URL.createObjectURL(new Blob([bytes], { type: mime })); const link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }

document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => { document.querySelectorAll('.tab,.panel').forEach((item) => item.classList.remove('active')); tab.classList.add('active'); $(`#${tab.dataset.tab}`).classList.add('active'); if (tab.dataset.tab === 'analysis') renderAnalysis(); if (tab.dataset.tab === 'inbox') loadInbox(); }));
document.querySelectorAll('[data-open-tab]').forEach((button) => button.addEventListener('click', () => document.querySelector(`[data-tab="${button.dataset.openTab}"]`).click()));
document.querySelectorAll('[data-password-toggle]').forEach((button) => button.addEventListener('click', () => {
  const input = $(`#${button.dataset.passwordToggle}`);
  const isHidden = input.type === 'password';
  input.type = isHidden ? 'text' : 'password';
  button.textContent = isHidden ? '숨김' : '표시';
  button.setAttribute('aria-label', isHidden ? '비밀 키 숨기기' : '비밀 키 표시');
}));
function makeDropTarget(inputId) {
  const input = $(inputId), dropTarget = input.closest('.file-drop');
  ['dragenter', 'dragover'].forEach((eventName) => dropTarget.addEventListener(eventName, (event) => { event.preventDefault(); dropTarget.classList.add('dragging'); }));
  ['dragleave', 'drop'].forEach((eventName) => dropTarget.addEventListener(eventName, (event) => { event.preventDefault(); dropTarget.classList.remove('dragging'); }));
  dropTarget.addEventListener('drop', (event) => {
    const file = event.dataTransfer.files[0];
    if (!file) return;
    const transfer = new DataTransfer(); transfer.items.add(file); input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
makeDropTarget('#sourceFile');
makeDropTarget('#encryptedFile');
$('#sourceFile').addEventListener('change', (event) => { const file = event.target.files[0]; $('#sourceMeta').textContent = file ? `${file.name} · ${bytesLabel(file.size)}${file.size > MAX_SIZE ? ' · 크기 초과' : ''}` : '텍스트 입력을 기다리는 중'; });
$('#encryptedFile').addEventListener('change', (event) => { const file = event.target.files[0]; $('#encryptedMeta').textContent = file ? `${file.name} · ${bytesLabel(file.size)}` : '보안 파일을 기다리는 중'; });
$('#encryptionMode').addEventListener('change', updateEncryptionMode); $('#loadDemo').addEventListener('click', loadDemoMessage); $('#encryptButton').addEventListener('click', encrypt); $('#decryptButton').addEventListener('click', decrypt);
$('#downloadEnc').addEventListener('click', () => { if (encryptedPackage) download(encryptedPackage, 'secure-message.enc', 'application/octet-stream'); });
$('#downloadRestored').addEventListener('click', () => { if (restoredFile) download(restoredFile.bytes, restoredFile.name, restoredFile.mime); });
$('#uploadEnc').addEventListener('click', uploadEncryptedPackage); $('#refreshInbox').addEventListener('click', loadInbox); $('#openInbox').addEventListener('click', () => document.querySelector('[data-tab="inbox"]').click());
  updateEncryptionMode();
window.addEventListener('resize', () => { if ($('#analysis').classList.contains('active')) renderAnalysis(); });
