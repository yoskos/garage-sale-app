// ─── Config (localStorage wrapper) ──────────────────────────────────────────
const cfg = {
  get url()    { return localStorage.getItem('serverUrl') || ''; },
  get secret() { return localStorage.getItem('sharedSecret') || ''; },
  set url(v)   { localStorage.setItem('serverUrl', v.replace(/\/+$/, '')); },
  set secret(v){ localStorage.setItem('sharedSecret', v.trim()); },
  get ok()     { return !!(this.url && this.secret); },
};

// ─── State ───────────────────────────────────────────────────────────────────
let lastResult    = null;
// Each entry: { blob, resolvedId: string|null, pendingUpload: Promise|null, failed: bool }
let capturedItems = [];
let lastNotes     = '';
let elapsedTimer  = null;

// ─── Crypto ──────────────────────────────────────────────────────────────────
async function sha256Hex(data) {
  const buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function sign(secret, bodyBytes) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const bodyHash = await sha256Hex(bodyBytes);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sigBuf = await crypto.subtle.sign(
    'HMAC', key,
    new TextEncoder().encode(`${ts}:${bodyHash}`),
  );
  const sig = [...new Uint8Array(sigBuf)].map(b => b.toString(16).padStart(2, '0')).join('');
  return { ts, sig };
}

// ─── Image processing ────────────────────────────────────────────────────────
async function prepareImage(file) {
  const bitmap = await createImageBitmap(file);
  const maxEdge = 1568;
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);

  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(w, h);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
    return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
  }
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
  return new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.8));
}

// ─── API calls ───────────────────────────────────────────────────────────────
async function apiHealth(url) {
  const resp = await fetch(`${url}/health`);
  return resp.ok;
}

// POST a single image to /upload; returns upload_id string.
async function apiUpload(blob) {
  const boundary = 'GSBoundary' + Math.random().toString(36).slice(2, 12);
  const enc = new TextEncoder();
  const imageBytes = new Uint8Array(await blob.arrayBuffer());
  const parts = [
    enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="photo.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
    imageBytes,
    enc.encode(`\r\n--${boundary}--\r\n`),
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const body = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { body.set(p, off); off += p.length; }

  const { ts, sig } = await sign(cfg.secret, body);
  const contentType = `multipart/form-data; boundary=${boundary}`;

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${cfg.url}/upload`);
    xhr.setRequestHeader('Content-Type', contentType);
    xhr.setRequestHeader('X-Timestamp', ts);
    xhr.setRequestHeader('X-Signature', sig);
    xhr.addEventListener('load', () => {
      let data;
      try { data = JSON.parse(xhr.responseText); } catch {
        reject(Object.assign(new Error(`HTTP ${xhr.status}`), { status: xhr.status }));
        return;
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data.upload_id);
      else reject(Object.assign(new Error(data?.detail || xhr.statusText), { status: xhr.status, data }));
    });
    xhr.addEventListener('error', () =>
      reject(Object.assign(new Error('Network error — check connection'), { status: 0 })));
    xhr.send(body);
  });
}

// POST upload IDs + notes to /price; returns PriceResponse.
async function apiPrice(uploadIds, notes, { onStatus, onProgress } = {}) {
  onStatus?.('Analyzing item…');
  onProgress?.(75);
  const payload = JSON.stringify({ upload_ids: uploadIds, notes: notes || null });
  const body = new TextEncoder().encode(payload);
  const { ts, sig } = await sign(cfg.secret, body);
  const resp = await fetch(`${cfg.url}/price`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Timestamp': ts,
      'X-Signature': sig,
    },
    body,
  });
  onProgress?.(100);
  let data;
  try { data = await resp.json(); } catch {
    throw Object.assign(new Error(`HTTP ${resp.status}`), { status: resp.status });
  }
  if (!resp.ok) throw Object.assign(new Error(data?.detail || resp.statusText), { status: resp.status, data });
  return data;
}

async function apiSale(requestId, itemLabel, suggestedPrice, soldPrice, sold) {
  const payload = JSON.stringify({
    request_id: requestId,
    item_label: itemLabel,
    suggested_price_usd: suggestedPrice,
    sold_price_usd: soldPrice,
    sold,
    notes: '',
  });
  const body = new TextEncoder().encode(payload);
  const { ts, sig } = await sign(cfg.secret, body);
  const resp = await fetch(`${cfg.url}/sale`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Timestamp': ts, 'X-Signature': sig },
    body,
  });
  if (!resp.ok) throw new Error((await resp.json()).detail || resp.statusText);
}

async function apiParseSale(text) {
  const payload = JSON.stringify({ text });
  const body = new TextEncoder().encode(payload);
  const { ts, sig } = await sign(cfg.secret, body);
  const resp = await fetch(`${cfg.url}/parse-sale`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Timestamp': ts, 'X-Signature': sig },
    body,
  });
  let data;
  try { data = await resp.json(); } catch {
    throw Object.assign(new Error(`HTTP ${resp.status}`), { status: resp.status });
  }
  if (!resp.ok) throw Object.assign(new Error(data?.detail || resp.statusText), { status: resp.status, data });
  return data; // { item_label, sold_price_usd }
}

async function apiSummary() {
  const body = new Uint8Array(0);
  const { ts, sig } = await sign(cfg.secret, body);
  const resp = await fetch(`${cfg.url}/summary`, {
    headers: { 'X-Timestamp': ts, 'X-Signature': sig },
  });
  if (!resp.ok) throw new Error(resp.statusText);
  return resp.json();
}

async function apiLedger() {
  const body = new Uint8Array(0);
  const { ts, sig } = await sign(cfg.secret, body);
  const resp = await fetch(`${cfg.url}/ledger`, {
    headers: { 'X-Timestamp': ts, 'X-Signature': sig },
  });
  if (!resp.ok) throw new Error(resp.statusText);
  return resp.json(); // { entries: [...] }
}

async function apiDeleteSale(id) {
  const body = new Uint8Array(0);
  const { ts, sig } = await sign(cfg.secret, body);
  const resp = await fetch(`${cfg.url}/sale/${id}`, {
    method: 'DELETE',
    headers: { 'X-Timestamp': ts, 'X-Signature': sig },
  });
  if (!resp.ok) throw new Error((await resp.json()).detail || resp.statusText);
}

async function apiUpdateSale(id, itemLabel, soldPrice) {
  const payload = JSON.stringify({ item_label: itemLabel, sold_price_usd: soldPrice });
  const body = new TextEncoder().encode(payload);
  const { ts, sig } = await sign(cfg.secret, body);
  const resp = await fetch(`${cfg.url}/sale/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'X-Timestamp': ts, 'X-Signature': sig },
    body,
  });
  if (!resp.ok) throw new Error((await resp.json()).detail || resp.statusText);
}

async function apiSearch(q) {
  const body = new Uint8Array(0);
  const { ts, sig } = await sign(cfg.secret, body);
  const resp = await fetch(`${cfg.url}/search?q=${encodeURIComponent(q)}`, {
    headers: { 'X-Timestamp': ts, 'X-Signature': sig },
  });
  if (!resp.ok) throw new Error((await resp.json()).detail || resp.statusText);
  return resp.json(); // { results: [...] }
}

// ─── Navigation ───────────────────────────────────────────────────────────────
function showView(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  document.getElementById(id).classList.remove('hidden');
}

// ─── Error messages ───────────────────────────────────────────────────────────
function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function errorMessage(err) {
  const status = err.status;
  if (status === 401) return 'Bad signature — re-check Setup';
  if (status === 404) return 'Upload expired — please retry';
  if (status === 413) return 'Image too large — try again';
  if (status === 429) return 'Slow down a sec';
  if (status >= 500) {
    const rid = err.data?.request_id;
    return rid ? `Server error (${rid})` : 'Server error — check connection';
  }
  return err.message || 'Network error — check connection';
}

// ─── Upload management ────────────────────────────────────────────────────────
function startUpload(item) {
  item.failed = false;
  item.pendingUpload = apiUpload(item.blob)
    .then(id  => { item.resolvedId = id; return id; })
    .catch(err => { item.failed = true; throw err; });
}

async function resolveAllUploads() {
  return Promise.all(capturedItems.map(item => {
    if (item.resolvedId) return item.resolvedId;
    if (item.failed) startUpload(item); // retry failed uploads
    return item.pendingUpload;
  }));
}

// ─── Capture UI ───────────────────────────────────────────────────────────────
let _thumbUrls = []; // track blob URLs so we can revoke on each redraw

function updateCaptureUI() {
  // Revoke stale object URLs before rebuilding thumbnails
  _thumbUrls.forEach(u => URL.revokeObjectURL(u));
  _thumbUrls = [];

  const count      = capturedItems.length;
  const shutterBtn = document.getElementById('shutter-btn');
  const strip      = document.getElementById('photo-strip');
  const priceBtn   = document.getElementById('get-price-btn');

  shutterBtn.disabled = count >= 3;
  strip.classList.toggle('hidden', count === 0);
  priceBtn.classList.toggle('hidden', count === 0);

  strip.innerHTML = '';
  capturedItems.forEach((item, i) => {
    const url  = URL.createObjectURL(item.blob);
    _thumbUrls.push(url);
    const wrap = document.createElement('div');
    wrap.className = 'photo-thumb';
    const img = document.createElement('img');
    img.src = url;
    img.alt = `Photo ${i + 1}`;
    const rm = document.createElement('button');
    rm.className = 'thumb-remove';
    rm.textContent = '×';
    rm.addEventListener('click', () => {
      capturedItems.splice(i, 1);
      updateCaptureUI();
    });
    wrap.appendChild(img);
    wrap.appendChild(rm);
    strip.appendChild(wrap);
  });
}

// ─── Setup view ───────────────────────────────────────────────────────────────
function initSetup() {
  const urlInput    = document.getElementById('setup-url');
  const secretInput = document.getElementById('setup-secret');
  const testBtn     = document.getElementById('setup-test-btn');
  const testResult  = document.getElementById('setup-test-result');
  const saveBtn     = document.getElementById('setup-save-btn');

  urlInput.value    = cfg.url;
  secretInput.value = cfg.secret;

  testBtn.addEventListener('click', async () => {
    const url = urlInput.value.trim().replace(/\/+$/, '');
    if (!url) { alert('Enter the server URL first.'); return; }
    testBtn.disabled = true;
    testBtn.textContent = 'Testing…';
    testResult.className = 'test-result hidden';
    try {
      const ok = await apiHealth(url);
      testResult.textContent = ok ? '✓ Connected' : '✗ No response';
      testResult.className = `test-result ${ok ? 'ok' : 'fail'}`;
    } catch {
      testResult.textContent = '✗ Could not reach server';
      testResult.className = 'test-result fail';
    } finally {
      testBtn.disabled = false;
      testBtn.textContent = 'Test Connection';
    }
  });

  saveBtn.addEventListener('click', () => {
    const url = urlInput.value.trim();
    const secret = secretInput.value.trim();
    if (!url || !secret) { alert('Both fields are required.'); return; }
    cfg.url = url;
    cfg.secret = secret;
    showView('view-capture');
  });
}

// ─── Capture view ─────────────────────────────────────────────────────────────
function initCapture() {
  const photoInput  = document.getElementById('photo-input');
  const shutterBtn  = document.getElementById('shutter-btn');
  const notesToggle = document.getElementById('notes-toggle');
  const notesInput  = document.getElementById('notes-input');
  const errorBox    = document.getElementById('capture-error');
  const errorMsg    = document.getElementById('capture-error-msg');
  const retryBtn    = document.getElementById('retry-btn');
  const overlay     = document.getElementById('loading-overlay');
  const elapsedEl   = document.getElementById('elapsed-display');

  document.getElementById('capture-settings-btn').addEventListener('click', () => showView('view-setup'));
  document.getElementById('capture-history-btn').addEventListener('click', () => {
    showView('view-history');
    loadHistory();
  });

  notesToggle.addEventListener('click', () => {
    const hidden = notesInput.classList.toggle('hidden');
    notesToggle.textContent = hidden ? '+ Add notes' : '− Notes';
    if (!hidden) notesInput.focus();
  });

  shutterBtn.addEventListener('click', () => photoInput.click());

  photoInput.addEventListener('change', async () => {
    const file = photoInput.files[0];
    if (!file) return;
    photoInput.value = '';
    errorBox.classList.add('hidden');
    // Do NOT set shutterBtn.disabled here — synchronous DOM changes before
    // an await cause Android/iOS to "lock" the render batch, and the async
    // updates that follow don't paint until the next user gesture.
    try {
      const blob = await prepareImage(file);
      const item = { blob, resolvedId: null, pendingUpload: null, failed: false };
      capturedItems.push(item);
      startUpload(item); // fire-and-forget background upload
    } catch {
      showCaptureError('Failed to process image — try again.');
    } finally {
      updateCaptureUI();
      // Belt-and-suspenders: mobile browsers sometimes defer repaints after
      // returning from the camera app; a second call in a new task flushes it.
      setTimeout(updateCaptureUI, 50);
    }
  });

  document.getElementById('get-price-btn').addEventListener('click', async () => {
    if (!capturedItems.length) return;
    lastNotes = notesInput.value;
    errorBox.classList.add('hidden');
    startLoading('Uploading photos…');
    await submitPrice();
  });

  retryBtn.addEventListener('click', async () => {
    if (!capturedItems.length) return;
    errorBox.classList.add('hidden');
    startLoading('Uploading photos…');
    await submitPrice();
  });

  async function submitPrice() {
    try {
      setProgress(10);
      const uploadIds = await resolveAllUploads();
      lastResult = await apiPrice(uploadIds, lastNotes, {
        onStatus: setStatus,
        onProgress: setProgress,
      });
      stopLoading();
      showResult();
    } catch (err) {
      stopLoading();
      showCaptureError(errorMessage(err));
      if (err.status === 401) showView('view-setup');
    }
  }

  function startLoading(initialStatus = 'Preparing…') {
    setStatus(initialStatus);
    setProgress(0);
    let secs = 0;
    elapsedEl.textContent = '0s';
    overlay.classList.remove('hidden');
    elapsedTimer = setInterval(() => { elapsedEl.textContent = `${++secs}s`; }, 1000);
  }

  function stopLoading() {
    clearInterval(elapsedTimer);
    overlay.classList.add('hidden');
  }

  function setStatus(text) {
    document.getElementById('status-label').textContent = text;
  }

  function setProgress(pct) {
    document.getElementById('progress-fill').style.width = `${pct}%`;
  }

  function showCaptureError(msg) {
    errorMsg.textContent = msg;
    errorBox.classList.remove('hidden');
  }
}

// ─── Result view ──────────────────────────────────────────────────────────────
function showResult() {
  if (!lastResult) return;
  const r = lastResult;

  document.getElementById('result-item').textContent = r.item;
  document.getElementById('result-price').textContent = `$${r.suggested_price_usd}`;
  document.getElementById('result-range').textContent =
    `Range $${r.price_range_usd[0]} – $${r.price_range_usd[1]}`;
  const retailEl = document.getElementById('result-retail');
  if (r.retail_price_new_usd != null) {
    retailEl.textContent = `Est. retail new: $${r.retail_price_new_usd}`;
    retailEl.classList.remove('hidden');
  } else {
    retailEl.classList.add('hidden');
  }
  document.getElementById('result-condition').textContent = r.condition_observed;
  document.getElementById('result-rationale').textContent = r.rationale;

  document.getElementById('result-cached').classList.toggle('hidden', !r.cache_hit);
  document.getElementById('result-error').classList.add('hidden');
  document.getElementById('sold-form').classList.add('hidden');
  document.getElementById('result-actions').classList.remove('hidden');
  document.getElementById('sold-price-input').value = r.suggested_price_usd;

  showView('view-result');
}

function initResult() {
  const soldBtn       = document.getElementById('sold-btn');
  const notSoldBtn    = document.getElementById('not-sold-btn');
  const reshootBtn    = document.getElementById('reshoot-btn');
  const refineBtn     = document.getElementById('refine-btn');
  const soldForm      = document.getElementById('sold-form');
  const refineForm    = document.getElementById('refine-form');
  const refineInput   = document.getElementById('refine-notes-input');
  const refineRetry   = document.getElementById('refine-retry-btn');
  const refineCancel  = document.getElementById('refine-cancel-btn');
  const actions       = document.getElementById('result-actions');
  const confirmBtn    = document.getElementById('sold-confirm-btn');
  const cancelBtn     = document.getElementById('sold-cancel-btn');
  const errorBox      = document.getElementById('result-error');
  const errorMsg      = document.getElementById('result-error-msg');

  soldBtn.addEventListener('click', () => {
    actions.classList.add('hidden');
    soldForm.classList.remove('hidden');
    document.getElementById('sold-price-input').focus();
  });

  cancelBtn.addEventListener('click', () => {
    soldForm.classList.add('hidden');
    actions.classList.remove('hidden');
  });

  refineBtn.addEventListener('click', () => {
    actions.classList.add('hidden');
    refineForm.classList.remove('hidden');
    refineInput.value = lastNotes;
    refineInput.focus();
  });

  refineCancel.addEventListener('click', () => {
    refineForm.classList.add('hidden');
    actions.classList.remove('hidden');
  });

  refineRetry.addEventListener('click', async () => {
    lastNotes = refineInput.value.trim();
    refineRetry.disabled = refineCancel.disabled = true;
    refineRetry.textContent = 'Analyzing…';
    errorBox.classList.add('hidden');
    try {
      // Server files were deleted after the last /price — force fresh uploads.
      capturedItems.forEach(item => {
        item.resolvedId = null;
        item.pendingUpload = null;
        item.failed = false;
        startUpload(item);
      });
      const uploadIds = await resolveAllUploads();
      lastResult = await apiPrice(uploadIds, lastNotes);
      refineForm.classList.add('hidden');
      showResult(); // re-renders the card and shows actions again
    } catch (err) {
      errorMsg.textContent = errorMessage(err);
      errorBox.classList.remove('hidden');
    } finally {
      refineRetry.disabled = refineCancel.disabled = false;
      refineRetry.textContent = 'Try again';
    }
  });

  reshootBtn.addEventListener('click', () => {
    capturedItems = [];
    lastResult = null;
    document.getElementById('notes-input').value = '';
    updateCaptureUI();
    showView('view-capture');
  });

  confirmBtn.addEventListener('click', async () => {
    const price = parseFloat(document.getElementById('sold-price-input').value);
    if (isNaN(price) || price < 0) { alert('Enter a valid price.'); return; }
    await logSale(price, true);
  });

  notSoldBtn.addEventListener('click', () => logSale(0, false));

  async function logSale(soldPrice, sold) {
    soldBtn.disabled = notSoldBtn.disabled = confirmBtn.disabled = true;
    errorBox.classList.add('hidden');
    try {
      await apiSale(
        lastResult.request_id,
        lastResult.item,
        lastResult.suggested_price_usd,
        soldPrice,
        sold,
      );
      capturedItems = [];
      lastResult = null;
      document.getElementById('notes-input').value = '';
      updateCaptureUI();
      showView('view-capture');
    } catch (err) {
      errorMsg.textContent = errorMessage(err);
      errorBox.classList.remove('hidden');
    } finally {
      soldBtn.disabled = notSoldBtn.disabled = confirmBtn.disabled = false;
    }
  }
}

// ─── History / Ledger view ────────────────────────────────────────────────────
let _modalEntry = null;
let _modalRow   = null;

function renderEntryView(row, entry) {
  const time = new Date(entry.created_at * 1000)
    .toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  row.innerHTML = `
    <span class="ledger-time"></span>
    <span class="ledger-label"></span>
    <span class="ledger-price"></span>`;
  row.querySelector('.ledger-time').textContent  = time;
  row.querySelector('.ledger-label').textContent = entry.item_label;
  row.querySelector('.ledger-price').textContent = `$${entry.sold_price_usd ?? '—'}`;
  row.onclick = () => openModal(entry, row);
}

function openModal(entry, row) {
  _modalEntry = entry;
  _modalRow   = row;
  document.getElementById('modal-time').textContent  = new Date(entry.created_at * 1000).toLocaleString();
  document.getElementById('modal-item').textContent  = entry.item_label;
  document.getElementById('modal-price').textContent = `$${entry.sold_price_usd ?? '—'}`;
  document.getElementById('modal-view-actions').classList.remove('hidden');
  document.getElementById('modal-edit-form').classList.add('hidden');
  document.getElementById('modal-error').classList.add('hidden');
  document.getElementById('ledger-modal').classList.remove('hidden');
}

function closeModal() {
  document.getElementById('ledger-modal').classList.add('hidden');
  _modalEntry = null;
  _modalRow   = null;
}

async function refreshSummary() {
  try {
    const s = await apiSummary();
    const vals = document.querySelectorAll('#history-content .stat-value');
    if (vals[0]) vals[0].textContent = s.total_items_sold;
    if (vals[1]) vals[1].textContent = `$${s.total_revenue_usd.toFixed(0)}`;
  } catch { /* silent */ }
}

async function downloadCsv() {
  try {
    const { entries } = await apiLedger();
    const rows = entries.filter(e => e.sold).map(e => {
      const d = new Date(e.created_at * 1000);
      const dt = `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
      const item = `"${e.item_label.replace(/"/g, '""')}"`;
      return `${dt},${item},${e.sold_price_usd ?? ''}`;
    });
    const csv = ['Date/Time,Item,Price ($)', ...rows].join('\n');
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })),
      download: 'garage-sale.csv',
    });
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (err) {
    alert(errorMessage(err));
  }
}

async function loadHistory() {
  const content = document.getElementById('history-content');
  content.innerHTML = '<p class="history-loading">Loading…</p>';
  try {
    const [s, { entries }] = await Promise.all([apiSummary(), apiLedger()]);
    const sold = entries.filter(e => e.sold);

    content.innerHTML = `
      <div class="summary-card">
        <h3>Today's Summary</h3>
        <div class="summary-stats">
          <div>
            <div class="stat-value">${s.total_items_sold}</div>
            <div class="stat-label">Items sold</div>
          </div>
          <div>
            <div class="stat-value">$${s.total_revenue_usd.toFixed(0)}</div>
            <div class="stat-label">Total</div>
          </div>
        </div>
      </div>
      ${sold.length === 0
        ? '<p class="history-empty">No sold items yet.</p>'
        : '<div class="ledger-list"></div>'}`;

    if (sold.length > 0) {
      const list = content.querySelector('.ledger-list');
      sold.forEach(entry => {
        const row = document.createElement('div');
        row.className = 'ledger-entry';
        renderEntryView(row, entry);
        list.appendChild(row);
      });
    }
  } catch {
    content.innerHTML = '<p class="history-empty">Could not load.<br>Check your connection.</p>';
  }
}

function initHistory() {
  document.getElementById('history-back-btn').addEventListener('click', () => showView('view-capture'));
  document.getElementById('history-refresh-btn').addEventListener('click', loadHistory);
  document.getElementById('ledger-download-btn').addEventListener('click', downloadCsv);

  const backdrop = document.getElementById('ledger-modal');
  backdrop.addEventListener('click', e => { if (e.target === backdrop) closeModal(); });
  document.getElementById('modal-close-btn').addEventListener('click', closeModal);

  document.getElementById('modal-edit-btn').addEventListener('click', () => {
    document.getElementById('modal-edit-name').value  = _modalEntry.item_label;
    document.getElementById('modal-edit-price').value = _modalEntry.sold_price_usd ?? '';
    document.getElementById('modal-view-actions').classList.add('hidden');
    document.getElementById('modal-edit-form').classList.remove('hidden');
    document.getElementById('modal-error').classList.add('hidden');
    document.getElementById('modal-edit-name').focus();
  });

  document.getElementById('modal-cancel-edit-btn').addEventListener('click', () => {
    document.getElementById('modal-edit-form').classList.add('hidden');
    document.getElementById('modal-view-actions').classList.remove('hidden');
    document.getElementById('modal-error').classList.add('hidden');
  });

  document.getElementById('modal-save-btn').addEventListener('click', async () => {
    const newLabel = document.getElementById('modal-edit-name').value.trim();
    const priceVal = document.getElementById('modal-edit-price').value;
    const newPrice = priceVal !== '' ? parseFloat(priceVal) : null;
    if (!newLabel) { document.getElementById('modal-edit-name').focus(); return; }
    const saveBtn = document.getElementById('modal-save-btn');
    saveBtn.disabled = true;
    document.getElementById('modal-error').classList.add('hidden');
    try {
      await apiUpdateSale(_modalEntry.id, newLabel, newPrice);
      _modalEntry.item_label     = newLabel;
      _modalEntry.sold_price_usd = newPrice;
      renderEntryView(_modalRow, _modalEntry);
      await refreshSummary();
      closeModal();
    } catch (err) {
      document.getElementById('modal-error').textContent = errorMessage(err);
      document.getElementById('modal-error').classList.remove('hidden');
    } finally {
      saveBtn.disabled = false;
    }
  });

  document.getElementById('modal-del-btn').addEventListener('click', async () => {
    if (!confirm(`Delete "${_modalEntry.item_label}"?`)) return;
    const delBtn = document.getElementById('modal-del-btn');
    delBtn.disabled = true;
    document.getElementById('modal-error').classList.add('hidden');
    try {
      await apiDeleteSale(_modalEntry.id);
      _modalRow.remove();
      await refreshSummary();
      closeModal();
    } catch (err) {
      document.getElementById('modal-error').textContent = errorMessage(err);
      document.getElementById('modal-error').classList.remove('hidden');
      delBtn.disabled = false;
    }
  });

  // ── Search ──
  const searchInput   = document.getElementById('search-input');
  const searchResults = document.getElementById('search-results');
  const historyContent = document.getElementById('history-content');
  let searchTimer = null;

  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = searchInput.value.trim();
    if (!q) {
      searchResults.classList.add('hidden');
      searchResults.innerHTML = '';
      historyContent.classList.remove('hidden');
      return;
    }
    searchTimer = setTimeout(() => runSearch(q), 400);
  });

  async function runSearch(q) {
    searchResults.innerHTML = '<p class="history-loading">Searching…</p>';
    searchResults.classList.remove('hidden');
    historyContent.classList.add('hidden');
    try {
      const { results } = await apiSearch(q);
      if (results.length === 0) {
        searchResults.innerHTML = '<p class="history-empty">No matches found.</p>';
        return;
      }
      searchResults.innerHTML = '';
      results.forEach(hit => {
        const div = document.createElement('div');
        div.className = 'search-hit';
        const range = hit.price_range_usd?.length === 2
          ? `$${hit.price_range_usd[0]}–$${hit.price_range_usd[1]}`
          : '';
        const ts = new Date(hit.created_at * 1000);
        const time = ts.toLocaleDateString() + ' ' + ts.toLocaleTimeString();
        div.innerHTML = `
          <div class="search-hit-item">${esc(hit.item)}</div>
          <div class="search-hit-price">$${hit.suggested_price_usd} <span class="muted small">${range}</span></div>
          <div class="search-hit-detail">${esc(hit.condition_observed)}</div>
          <div class="search-hit-detail">${esc(hit.rationale)}</div>
          <div class="muted small">${time}</div>`;
        searchResults.appendChild(div);
      });
    } catch (err) {
      searchResults.innerHTML = `<p class="history-empty">${errorMessage(err)}</p>`;
    }
  }
}

// ─── Quick Sale ───────────────────────────────────────────────────────────────
function initQuickSale() {
  const inputArea  = document.getElementById('sale-input-area');
  const confirmDiv = document.getElementById('quick-sale-confirm');
  const textarea   = document.getElementById('quick-sale-text');
  const logBtn     = document.getElementById('quick-sale-analyze-btn');
  const micBtn     = document.getElementById('quick-sale-mic-btn');
  const itemEl     = document.getElementById('quick-sale-item');
  const priceEl    = document.getElementById('quick-sale-price');
  const confirmBtn = document.getElementById('quick-sale-confirm-btn');
  const editBtn    = document.getElementById('quick-sale-edit-btn');
  const errorEl    = document.getElementById('quick-sale-error');

  let parsed = null;
  let recognition = null;
  let fromAudio = false;
  let autoLogTimer = null;

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) micBtn.classList.add('hidden');

  function updateLogBtn() {
    logBtn.classList.toggle('hidden', !textarea.value.trim());
  }

  function clearAutoLog() {
    if (autoLogTimer) { clearInterval(autoLogTimer); autoLogTimer = null; }
  }

  function reset() {
    clearAutoLog();
    if (recognition) { recognition.abort(); recognition = null; }
    micBtn.classList.remove('recording');
    fromAudio = false;
    inputArea.classList.remove('hidden');
    confirmDiv.classList.add('hidden');
    errorEl.classList.add('hidden');
    logBtn.classList.add('hidden');
    textarea.value = '';
    parsed = null;
    confirmBtn.disabled = editBtn.disabled = false;
    confirmBtn.textContent = 'Confirm Sale';
  }

  async function doAnalyze() {
    const text = textarea.value.trim();
    if (!text) return;
    errorEl.classList.add('hidden');
    logBtn.disabled = micBtn.disabled = true;
    logBtn.textContent = 'Analyzing…';
    try {
      parsed = await apiParseSale(text);
      itemEl.textContent = parsed.item_label;
      priceEl.textContent = parsed.sold_price_usd > 0 ? `$${parsed.sold_price_usd}` : '—';
      inputArea.classList.add('hidden');
      confirmDiv.classList.remove('hidden');
      if (fromAudio) startAutoLog();
    } catch (err) {
      errorEl.textContent = errorMessage(err);
      errorEl.classList.remove('hidden');
    } finally {
      logBtn.disabled = micBtn.disabled = false;
      logBtn.textContent = 'Log Sale';
    }
  }

  function startAutoLog() {
    let secs = 3;
    confirmBtn.textContent = `Confirm (${secs})`;
    autoLogTimer = setInterval(() => {
      secs--;
      if (secs <= 0) {
        clearAutoLog();
        confirmBtn.click();
      } else {
        confirmBtn.textContent = `Confirm (${secs})`;
      }
    }, 1000);
  }

  textarea.addEventListener('input', updateLogBtn);
  logBtn.addEventListener('click', () => { fromAudio = false; doAnalyze(); });

  if (SpeechRecognition) {
    micBtn.addEventListener('click', () => {
      if (recognition) { recognition.stop(); return; }

      errorEl.classList.add('hidden');
      recognition = new SpeechRecognition();
      recognition.lang = 'en-US';
      recognition.interimResults = true;
      recognition.continuous = false;

      micBtn.classList.add('recording');

      recognition.onresult = (event) => {
        textarea.value = Array.from(event.results).map(r => r[0].transcript).join('');
        updateLogBtn();
      };

      recognition.onend = () => {
        recognition = null;
        micBtn.classList.remove('recording');
        if (textarea.value.trim()) { fromAudio = true; doAnalyze(); }
      };

      recognition.onerror = (event) => {
        recognition = null;
        micBtn.classList.remove('recording');
        if (event.error === 'not-allowed') {
          errorEl.textContent = 'Microphone permission denied';
          errorEl.classList.remove('hidden');
        } else if (event.error !== 'no-speech') {
          errorEl.textContent = `Mic error: ${event.error}`;
          errorEl.classList.remove('hidden');
        }
      };

      recognition.start();
    });
  }

  editBtn.addEventListener('click', () => {
    clearAutoLog();
    fromAudio = false;
    confirmDiv.classList.add('hidden');
    inputArea.classList.remove('hidden');
    updateLogBtn();
  });

  confirmBtn.addEventListener('click', async () => {
    if (!parsed) return;
    confirmBtn.disabled = editBtn.disabled = true;
    confirmBtn.textContent = 'Saving…';
    errorEl.classList.add('hidden');
    try {
      const payload = JSON.stringify({
        request_id: null,
        item_label: parsed.item_label,
        suggested_price_usd: null,
        sold_price_usd: parsed.sold_price_usd,
        sold: true,
        notes: null,
      });
      const body = new TextEncoder().encode(payload);
      const { ts, sig } = await sign(cfg.secret, body);
      const resp = await fetch(`${cfg.url}/sale`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Timestamp': ts, 'X-Signature': sig },
        body,
      });
      if (!resp.ok) throw new Error((await resp.json()).detail || resp.statusText);
      confirmBtn.textContent = '✓ Logged!';
      setTimeout(reset, 800);
    } catch (err) {
      errorEl.textContent = errorMessage(err);
      errorEl.classList.remove('hidden');
      confirmBtn.disabled = editBtn.disabled = false;
      confirmBtn.textContent = 'Confirm Sale';
    }
  });
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
function init() {
  if (!crypto.subtle) {
    document.getElementById('no-crypto-banner').classList.remove('hidden');
    return;
  }

  initSetup();
  initCapture();
  initQuickSale();
  initResult();
  initHistory();

  showView(cfg.ok ? 'view-capture' : 'view-setup');
}

document.addEventListener('DOMContentLoaded', init);
