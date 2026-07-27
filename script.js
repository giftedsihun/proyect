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

// 부울대수: XOR은 같은 키를 두 번 적용하면 원래 값으로 돌아옵니다. A⊕K⊕K=A
function xorBytes(data, key) { const result = new Uint8Array(data.length); for (let i = 0; i < data.length; i++) result[i] = data[i] ^ key[i % key.length]; return result; }
async function deriveKey(password) { return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(password))); }
async function sha256(data) { return new Uint8Array(await crypto.subtle.digest('SHA-256', data)); }
function hex(bytes) { return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(''); }
function equalBytes(a, b) { return a.length === b.length && a.every((value, index) => value === b[index]); }

function makePackage(meta, frequencies, bitLength, encrypted, integrity) {
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
function parsePackage(bytes) {
  if (bytes.length < 1072 || String.fromCharCode(...bytes.slice(0, 4)) !== 'SME1') throw new Error('Secure Message .enc 파일이 아닙니다.');
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
  return { name, mime, originalSize, bitLength, frequencies, integrity, encrypted };
}

function setProcess(id, state) { const element = $(id); element.classList.remove('working', 'done'); if (state) element.classList.add(state); element.querySelector('i').textContent = state === 'done' ? '●' : state === 'working' ? '◌' : '○'; }
function updateSteps(container, count) { [...container.querySelectorAll('.step')].forEach((step, index) => step.classList.toggle('active', index < count)); }
function sourceFromInput() {
  const file = $('#sourceFile').files[0]; const text = $('#messageInput').value;
  if (file) return file.size > MAX_SIZE ? Promise.reject(new Error('파일은 25MB 이하만 사용할 수 있습니다.')) : file.arrayBuffer().then((buffer) => ({ bytes: new Uint8Array(buffer), name: file.name, mime: file.type || 'application/octet-stream' }));
  if (!text.trim()) return Promise.reject(new Error('텍스트를 입력하거나 파일을 선택하세요.'));
  return Promise.resolve({ bytes: encoder.encode(text), name: 'secure-message.txt', mime: 'text/plain;charset=utf-8' });
}

async function encrypt() {
  const button = $('#encryptButton'), keyText = $('#encryptKey').value;
  if (!keyText) return setStatus('#encryptStatus', '비밀 키를 입력하세요.', 'error');
  button.disabled = true; $('#resultBox').classList.add('hidden');
  try {
    const source = await sourceFromInput(); if (!source.bytes.length) throw new Error('빈 데이터는 암호화할 수 없습니다.');
    setStatus('#encryptStatus', '바이트 빈도를 계산하고 허프만 트리를 생성하는 중...'); setProcess('#processHuffman', 'working'); updateSteps($('#encrypt .steps'), 2); await sleep(250);
    const frequencies = frequencyTable(source.bytes), root = buildHuffman(frequencies), codes = makeCodes(root), compressed = compressHuffman(source.bytes, codes);
    renderTree(root, codes); setProcess('#processHuffman', 'done'); $('#treeNote').textContent = `${frequencies.filter(Boolean).length}개 바이트 종류 · ${compressed.bitLength.toLocaleString()} bits`;
    setStatus('#encryptStatus', 'SHA-256으로 키를 256비트로 확장하는 중...'); setProcess('#processHash', 'working'); updateSteps($('#encrypt .steps'), 3);
    const key = await deriveKey(keyText); $('#hashDisplay code').textContent = `${keyText} → SHA-256 → ${hex(key).slice(0, 32)}... (32 bytes)`; setProcess('#processHash', 'done'); await sleep(180);
    setStatus('#encryptStatus', '압축 데이터에 XOR 암호화를 적용하는 중...'); setProcess('#processXor', 'working');
    const encrypted = xorBytes(compressed.packed, key), integrity = await sha256(source.bytes); setProcess('#processXor', 'done');
    encryptedPackage = makePackage({ ...source, size: source.bytes.length }, frequencies, compressed.bitLength, encrypted, integrity); setProcess('#processReady', 'done'); updateSteps($('#encrypt .steps'), 4);
    const ratio = (1 - compressed.packed.length / source.bytes.length) * 100;
    $('#compressionText').textContent = `${bytesLabel(source.bytes.length)} → ${bytesLabel(compressed.packed.length)} (${ratio >= 0 ? ratio.toFixed(1) : '+' + Math.abs(ratio).toFixed(1)}%)`;
    $('#packageSize').textContent = bytesLabel(encryptedPackage.length); $('#resultBox').classList.remove('hidden'); $('#uploadBox').classList.remove('hidden');
    analysisData = { original: source.bytes, encrypted, simple: xorBytes(compressed.packed, encoder.encode(keyText)), hashed: encrypted }; renderAnalysis();
    setStatus('#encryptStatus', '완료! .enc 파일을 다운로드해 안전하게 전달하세요.', 'success');
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
  if (!file) return setStatus('#decryptStatus', '.enc 파일을 선택하세요.', 'error'); if (!keyText) return setStatus('#decryptStatus', '암호화에 사용한 비밀 키를 입력하세요.', 'error'); if (file.size > MAX_SIZE + 2048) return setStatus('#decryptStatus', '지원 크기(원본 25MB)를 초과한 파일입니다.', 'error');
  button.disabled = true; try {
    setStatus('#decryptStatus', '보안 패키지를 읽는 중...'); const pack = parsePackage(new Uint8Array(await file.arrayBuffer())); updateSteps($('#decrypt .steps'), 2);
    setStatus('#decryptStatus', 'SHA-256 키로 XOR 복호화하는 중...'); const key = await deriveKey(keyText), compressed = xorBytes(pack.encrypted, key); updateSteps($('#decrypt .steps'), 3);
    setStatus('#decryptStatus', '허프만 트리로 원본을 복원하고 검증하는 중...'); const output = decompressHuffman(compressed, pack.bitLength, buildHuffman(pack.frequencies), pack.originalSize); const digest = await sha256(output);
    if (!equalBytes(digest, pack.integrity)) throw new Error('무결성 검증에 실패했습니다. 키가 틀렸거나 파일이 손상되었습니다.');
    restoredFile = { bytes: output, name: pack.name || 'restored-file', mime: pack.mime }; $('#recoveryEmpty').classList.add('hidden'); $('#recoveryResult').classList.remove('hidden'); $('#restoredInfo').textContent = `RESTORED / ${pack.name} / ${bytesLabel(output.length)} / SHA-256 VERIFIED`;
    const isText = pack.mime.startsWith('text/') || /\.(txt|csv|json|md|html|js|css)$/i.test(pack.name); $('#restoredText').classList.toggle('hidden', !isText); if (isText) $('#restoredText').textContent = decoder.decode(output); updateSteps($('#decrypt .steps'), 4); setStatus('#decryptStatus', '복원 완료! 무결성 검증을 통과했습니다.', 'success');
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
function renderAnalysis() { if (!analysisData) return; $('#analysisEmpty').classList.add('hidden'); $('#analysisContent').classList.remove('hidden'); requestAnimationFrame(() => { drawDistribution('#mainDistribution', [{ label: '원본', data: analysisData.original, color: '#e9c76d' }, { label: 'SHA-256 XOR 암호문', data: analysisData.encrypted, color: '#55e6cf' }]); drawDistribution('#keyDistribution', [{ label: '단순 반복 키', data: analysisData.simple, color: '#ff7e72' }, { label: 'SHA-256 확장 키', data: analysisData.hashed, color: '#55e6cf' }]); }); }
function download(bytes, name, mime) { const url = URL.createObjectURL(new Blob([bytes], { type: mime })); const link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }

// 그래프: 서버=정점, 연결=간선, 시간/위험도=음이 아닌 가중치로 모델링합니다.
const networkNodes = [
  { id: 'sender', name: '나', sub: '송신자', x: 70, y: 205 },
  { id: 'seoul', name: '서울 게이트웨이', sub: '보안 노드', x: 220, y: 105 },
  { id: 'daejeon', name: '대전 릴레이', sub: '중계 서버', x: 330, y: 290 },
  { id: 'incheon', name: '인천 보안 노드', sub: '중계 서버', x: 425, y: 95 },
  { id: 'busan', name: '부산 릴레이', sub: '중계 서버', x: 500, y: 290 },
  { id: 'gwangju', name: '광주 릴레이', sub: '중계 서버', x: 620, y: 185 },
  { id: 'receiver', name: '상대방', sub: '수신자', x: 750, y: 195 }
];
const networkEdges = [
  ['sender', 'seoul', 12, 3], ['sender', 'daejeon', 20, 2], ['seoul', 'daejeon', 11, 5], ['seoul', 'incheon', 9, 2],
  ['daejeon', 'incheon', 16, 4], ['daejeon', 'busan', 13, 2], ['incheon', 'busan', 14, 5], ['incheon', 'gwangju', 18, 1],
  ['busan', 'gwangju', 10, 3], ['busan', 'receiver', 23, 2], ['gwangju', 'receiver', 8, 4]
].map(([from, to, time, risk]) => ({ from, to, time, risk }));
const defaultNetworkWeights = networkEdges.map(({ time, risk }) => ({ time, risk }));
let routeState = { path: [], visited: [], result: null, mode: 'time' };
function nodeById(id) { return networkNodes.find((node) => node.id === id); }
function edgeKey(a, b) { return [a, b].sort().join('|'); }

// 다익스트라: 최소 우선순위 큐에서 가장 비용이 작은 미방문 정점을 꺼내 거리를 갱신합니다.
function dijkstra(start, end, weightField) {
  const distances = Object.fromEntries(networkNodes.map((node) => [node.id, Infinity]));
  const previous = {}, visited = [], steps = [], queue = new MinHeap(); distances[start] = 0; queue.push({ id: start, freq: 0 });
  while (queue.length) {
    const current = queue.pop(); if (current.freq !== distances[current.id]) continue;
    visited.push(current.id); steps.push(`${nodeById(current.id).name} 선택: 현재 ${weightField === 'time' ? '시간' : '위험도'} ${current.freq}`);
    if (current.id === end) break;
    networkEdges.filter((edge) => edge.from === current.id || edge.to === current.id).forEach((edge) => {
      const neighbor = edge.from === current.id ? edge.to : edge.from, candidate = current.freq + edge[weightField];
      if (candidate < distances[neighbor]) { const old = distances[neighbor]; distances[neighbor] = candidate; previous[neighbor] = current.id; queue.push({ id: neighbor, freq: candidate }); steps.push(`  ${nodeById(neighbor).name}: ${old === Infinity ? '∞' : old} → ${candidate} (${nodeById(current.id).name} 경유)`); }
    });
  }
  const path = []; for (let cursor = end; cursor; cursor = previous[cursor]) { path.unshift(cursor); if (cursor === start) break; }
  if (path[0] !== start) return { path: [], visited, steps, cost: Infinity };
  return { path, visited, steps, cost: distances[end] };
}
function renderNetwork() {
  const selectedEdges = new Set(routeState.path.slice(1).map((id, index) => edgeKey(routeState.path[index], id)));
  const { mode, visited, path } = routeState, start = $('#routeStart').value || 'sender', end = $('#routeEnd').value || 'receiver';
  const edges = networkEdges.map((edge) => { const a = nodeById(edge.from), b = nodeById(edge.to), active = selectedEdges.has(edgeKey(edge.from, edge.to)); return `<line class="network-edge ${active ? 'route-edge' : ''}" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"/><text class="edge-weight" x="${(a.x + b.x) / 2}" y="${(a.y + b.y) / 2 - 7}">${edge[mode]}${mode === 'time' ? 'ms' : ''}</text>`; }).join('');
  const nodes = networkNodes.map((node) => { const classes = ['network-node']; if (visited.includes(node.id)) classes.push('visited'); if (path.includes(node.id)) classes.push('route-node'); if (node.id === start || node.id === end) classes.push('start-end'); return `<circle class="${classes.join(' ')}" cx="${node.x}" cy="${node.y}" r="25"/><text class="server-label" x="${node.x}" y="${node.y - 35}">${node.name}</text><text class="server-sub" x="${node.x}" y="${node.y + 4}">${node.sub}</text>`; }).join('');
  $('#networkViewport').innerHTML = `<svg class="network-svg" viewBox="0 0 820 390" aria-label="가중치 네트워크 그래프">${edges}${nodes}</svg>`;
}
function populateRouteSelects() { ['#routeStart', '#routeEnd'].forEach((selector) => { $(selector).innerHTML = networkNodes.map((node) => `<option value="${node.id}">${node.name} (${node.sub})</option>`).join(''); }); $('#routeStart').value = 'sender'; $('#routeEnd').value = 'receiver'; renderNetwork(); }
function edgeName(edge) { return `${nodeById(edge.from).name} ↔ ${nodeById(edge.to).name}`; }
function resetRouteView() { routeState = { path: [], visited: [], result: null, mode: $('#routeMode').value }; $('#routeResult').classList.add('hidden'); $('#simulateButton').classList.add('hidden'); $('#dijkstraSteps').innerHTML = '<li>가중치가 변경되었습니다. 다익스트라 경로를 다시 계산하세요.</li>'; renderNetwork(); }
function renderWeightTable() {
  $('#weightTableBody').innerHTML = networkEdges.map((edge, index) => `<tr><td>${edgeName(edge)}</td><td><input data-edge="${index}" data-weight="time" type="number" min="1" max="999" value="${edge.time}" aria-label="${edgeName(edge)} 전송 시간"></td><td><input data-edge="${index}" data-weight="risk" type="number" min="1" max="10" value="${edge.risk}" aria-label="${edgeName(edge)} 위험도"></td></tr>`).join('');
  $('#weightTableBody').querySelectorAll('input').forEach((input) => input.addEventListener('change', () => { const value = Number(input.value), edge = networkEdges[Number(input.dataset.edge)], field = input.dataset.weight, max = field === 'risk' ? 10 : 999; edge[field] = Number.isFinite(value) ? Math.min(max, Math.max(1, Math.round(value))) : 1; input.value = edge[field]; resetRouteView(); }));
}
function compareRoutes() {
  const start = $('#routeStart').value, end = $('#routeEnd').value;
  if (start === end) return setStatus('#routeStatus', '출발 서버와 도착 서버는 다르게 선택하세요.', 'error');
  const timeResult = dijkstra(start, end, 'time'), riskResult = dijkstra(start, end, 'risk');
  const resultCard = (title, result, unit, extraClass = '') => `<div class="comparison-card ${extraClass}"><span>${title}</span><strong>${result.path.map((id) => nodeById(id).name).join(' → ')}</strong><small>총 비용: ${result.cost}${unit} · 방문 정점 ${result.visited.length}개</small></div>`;
  $('#comparisonResult').innerHTML = resultCard('TIME / 최단 시간', timeResult, 'ms') + resultCard('RISK / 최소 위험도', riskResult, '점', 'risk');
  setStatus('#routeStatus', '동일한 그래프에서 가중치 기준에 따라 두 최적 경로를 비교했습니다.', 'success');
}
function calculateRoute() {
  const start = $('#routeStart').value, end = $('#routeEnd').value, mode = $('#routeMode').value;
  if (start === end) return setStatus('#routeStatus', '출발 서버와 도착 서버는 다르게 선택하세요.', 'error');
  const result = dijkstra(start, end, mode); routeState = { ...result, mode }; renderNetwork();
  $('#dijkstraSteps').innerHTML = result.steps.map((step) => `<li>${escapeHtml(step)}</li>`).join('');
  const metric = mode === 'time' ? '총 전송 시간' : '총 위험도'; $('#routeResult').innerHTML = `<span>DIJKSTRA RESULT / ${metric.toUpperCase()}</span><strong>${result.path.map((id) => nodeById(id).name).join(' → ')}</strong><small>${metric}: ${result.cost}${mode === 'time' ? 'ms' : '점'} · 방문 정점: ${result.visited.length}개</small>`; $('#routeResult').classList.remove('hidden'); $('#simulateButton').classList.remove('hidden'); setStatus('#routeStatus', `${metric} ${result.cost}${mode === 'time' ? 'ms' : '점'}의 경로를 찾았습니다.`, 'success');
}
function simulatePacket() {
  if (!routeState.path.length) return; const svg = $('#networkViewport svg'); svg.querySelector('.packet')?.remove(); const points = routeState.path.map(nodeById).map((node) => `${node.x},${node.y}`).join(' ');
  const packet = document.createElementNS('http://www.w3.org/2000/svg', 'circle'); packet.setAttribute('class', 'packet'); packet.setAttribute('r', '9'); packet.innerHTML = `<animateMotion dur="3s" repeatCount="1" path="M ${routeState.path.map((id) => { const node = nodeById(id); return `${node.x} ${node.y}`; }).join(' L ')}"/>`; svg.append(packet); setStatus('#routeStatus', encryptedPackage ? '암호화된 .enc 패킷이 최적 경로를 따라 이동합니다. 원문은 중계 서버에 표시되지 않습니다.' : '경로 시뮬레이션입니다. 암호화 후에는 .enc 패킷 전송으로 연결됩니다.', 'success');
}

document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => { document.querySelectorAll('.tab,.panel').forEach((item) => item.classList.remove('active')); tab.classList.add('active'); $(`#${tab.dataset.tab}`).classList.add('active'); if (tab.dataset.tab === 'analysis') renderAnalysis(); if (tab.dataset.tab === 'inbox') loadInbox(); }));
document.querySelectorAll('[data-open-tab]').forEach((button) => button.addEventListener('click', () => document.querySelector(`[data-tab="${button.dataset.openTab}"]`).click()));
$('#sourceFile').addEventListener('change', (event) => { const file = event.target.files[0]; $('#sourceMeta').textContent = file ? `${file.name} · ${bytesLabel(file.size)}${file.size > MAX_SIZE ? ' · 크기 초과' : ''}` : '텍스트 입력을 기다리는 중'; });
$('#encryptedFile').addEventListener('change', (event) => { const file = event.target.files[0]; $('#encryptedMeta').textContent = file ? `${file.name} · ${bytesLabel(file.size)}` : '보안 파일을 기다리는 중'; });
$('#encryptButton').addEventListener('click', encrypt); $('#decryptButton').addEventListener('click', decrypt);
$('#downloadEnc').addEventListener('click', () => { if (encryptedPackage) download(encryptedPackage, 'secure-message.enc', 'application/octet-stream'); });
$('#downloadRestored').addEventListener('click', () => { if (restoredFile) download(restoredFile.bytes, restoredFile.name, restoredFile.mime); });
$('#uploadEnc').addEventListener('click', uploadEncryptedPackage); $('#refreshInbox').addEventListener('click', loadInbox); $('#openInbox').addEventListener('click', () => document.querySelector('[data-tab="inbox"]').click());
populateRouteSelects(); renderWeightTable(); $('#routeButton').addEventListener('click', calculateRoute); $('#simulateButton').addEventListener('click', simulatePacket); $('#compareRoutes').addEventListener('click', compareRoutes); $('#resetWeights').addEventListener('click', () => { networkEdges.forEach((edge, index) => Object.assign(edge, defaultNetworkWeights[index])); renderWeightTable(); resetRouteView(); setStatus('#routeStatus', '모든 간선 가중치를 기본값으로 복원했습니다.', 'success'); }); ['#routeMode', '#routeStart', '#routeEnd'].forEach((selector) => $(selector).addEventListener('change', resetRouteView));
window.addEventListener('resize', () => { if ($('#analysis').classList.contains('active')) renderAnalysis(); });
