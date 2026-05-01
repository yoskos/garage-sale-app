// ─── Config (localStorage wrapper) ──────────────────────────────────────────
const cfg = {
  get url()    { return localStorage.getItem('serverUrl') || ''; },
  get secret() { return localStorage.getItem('sharedSecret') || ''; },
  set url(v)   { localStorage.setItem('serverUrl', v.replace(/\/+$/, '')); },
  set secret(v){ localStorage.setItem('sharedSecret', v.trim()); },
  get ok()     { return !!(this.url && this.secret); },
};

// ─── State ───────────────────────────────────────────────────────────────────
let lastResult   = null;   // PriceResponse from last /price call
let capturedBlob = null;   // prepared image Blob (kept for retry)
let lastNotes    = '';
let elapsedTimer = null;

// ─── Crypto ──────────────────────────────────────────────────────────────────
async function sha256Hex(data /* Uint8Array | ArrayBuffer */) {
  const buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function sign(secret, bodyBytes /* Uint8Array */) {
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
  // Fallback for older Safari
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
  return new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.8));
}

// Build a multipart body manually so we can sign the exact bytes we send.
async function buildMultipart(imageBlob, notes) {
  const boundary = 'GSBoundary' + Math.random().toString(36).slice(2, 12);
  const enc = new TextEncoder();
  const imageBytes = new Uint8Array(await imageBlob.arrayBuffer());

  const parts = [
    enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="photo.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
    imageBytes,
    enc.encode('\r\n'),
  ];
  if (notes && notes.trim()) {
    parts.push(enc.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="notes"\r\n\r\n${notes.trim()}\r\n`,
    ));
  }
  parts.push(enc.encode(`--${boundary}--\r\n`));

  const total = parts.reduce((n, p) => n + p.length, 0);
  const body = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { body.set(p, off); off += p.length; }

  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

// ─── API calls ───────────────────────────────────────────────────────────────
async function apiHealth(url) {
  const resp = await fetch(`${url}/health`);
  return resp.ok;
}

async function apiPrice(imageBlob, notes) {
  const { body, contentType } = await buildMultipart(imageBlob, notes);
  const { ts, sig } = await sign(cfg.secret, body);
  const resp = await fetch(`${cfg.url}/price`, {
    method: 'POST',
    headers: { 'Content-Type': contentType, 'X-Timestamp': ts, 'X-Signature': sig },
    body,
  });
  const data = await resp.json();
  if (!resp.ok) throw Object.assign(new Error(data.detail || resp.statusText), { status: resp.status, data });
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
    headers: {
      'Content-Type': 'application/json',
      'X-Timestamp': ts,
      'X-Signature': sig,
    },
    body,
  });
  if (!resp.ok) throw new Error((await resp.json()).detail || resp.statusText);
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

// ─── Navigation ───────────────────────────────────────────────────────────────
function showView(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  document.getElementById(id).classList.remove('hidden');
}

// ─── Error messages ───────────────────────────────────────────────────────────
function errorMessage(err) {
  const status = err.status;
  if (status === 401) return 'Bad signature — re-check Setup';
  if (status === 413) return 'Image too large — try again';
  if (status === 429) return 'Slow down a sec';
  if (status >= 500) {
    const rid = err.data?.request_id;
    return rid ? `Server error (${rid})` : 'Server error — check connection';
  }
  return err.message || 'Network error — check connection';
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
    notesToggle.textContent = hidden ? '＋ Add notes' : '－ Notes';
    if (!hidden) notesInput.focus();
  });

  shutterBtn.addEventListener('click', () => photoInput.click());

  photoInput.addEventListener('change', async () => {
    const file = photoInput.files[0];
    if (!file) return;
    photoInput.value = '';
    errorBox.classList.add('hidden');
    try {
      capturedBlob = await prepareImage(file);
      lastNotes = notesInput.value;
      await submitPrice();
    } catch (err) {
      showCaptureError('Failed to process image — try again.');
    }
  });

  retryBtn.addEventListener('click', async () => {
    if (!capturedBlob) return;
    errorBox.classList.add('hidden');
    await submitPrice();
  });

  async function submitPrice() {
    startLoading();
    try {
      lastResult = await apiPrice(capturedBlob, lastNotes);
      stopLoading();
      showResult();
    } catch (err) {
      stopLoading();
      const msg = errorMessage(err);
      showCaptureError(msg);
      if (err.status === 401) showView('view-setup');
    }
  }

  function startLoading() {
    let secs = 0;
    elapsedEl.textContent = '0s';
    overlay.classList.remove('hidden');
    elapsedTimer = setInterval(() => { elapsedEl.textContent = `${++secs}s`; }, 1000);
  }

  function stopLoading() {
    clearInterval(elapsedTimer);
    overlay.classList.add('hidden');
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
  document.getElementById('result-condition').textContent = r.condition_observed;
  document.getElementById('result-rationale').textContent = r.rationale;

  const cachedBadge = document.getElementById('result-cached');
  cachedBadge.classList.toggle('hidden', !r.cache_hit);

  document.getElementById('result-error').classList.add('hidden');
  document.getElementById('sold-form').classList.add('hidden');
  document.getElementById('result-actions').classList.remove('hidden');
  document.getElementById('sold-price-input').value = r.suggested_price_usd;

  showView('view-result');
}

function initResult() {
  const soldBtn     = document.getElementById('sold-btn');
  const notSoldBtn  = document.getElementById('not-sold-btn');
  const reshootBtn  = document.getElementById('reshoot-btn');
  const soldForm    = document.getElementById('sold-form');
  const actions     = document.getElementById('result-actions');
  const confirmBtn  = document.getElementById('sold-confirm-btn');
  const cancelBtn   = document.getElementById('sold-cancel-btn');
  const errorBox    = document.getElementById('result-error');
  const errorMsg    = document.getElementById('result-error-msg');

  soldBtn.addEventListener('click', () => {
    actions.classList.add('hidden');
    soldForm.classList.remove('hidden');
    document.getElementById('sold-price-input').focus();
  });

  cancelBtn.addEventListener('click', () => {
    soldForm.classList.add('hidden');
    actions.classList.remove('hidden');
  });

  reshootBtn.addEventListener('click', () => {
    capturedBlob = null;
    lastResult = null;
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
      capturedBlob = null;
      lastResult = null;
      showView('view-capture');
    } catch (err) {
      errorMsg.textContent = errorMessage(err);
      errorBox.classList.remove('hidden');
    } finally {
      soldBtn.disabled = notSoldBtn.disabled = confirmBtn.disabled = false;
    }
  }
}

// ─── History view ─────────────────────────────────────────────────────────────
async function loadHistory() {
  const content = document.getElementById('history-content');
  content.innerHTML = '<p class="history-loading">Loading…</p>';
  try {
    const s = await apiSummary();
    const discount = Math.round(s.avg_discount_vs_suggested * 100);
    content.innerHTML = `
      <div class="summary-card">
        <h3>Today's Summary</h3>
        <div class="summary-stats">
          <div>
            <div class="stat-value">${s.total_items_sold}/${s.total_items_priced}</div>
            <div class="stat-label">Sold</div>
          </div>
          <div>
            <div class="stat-value">$${s.total_revenue_usd.toFixed(0)}</div>
            <div class="stat-label">Revenue</div>
          </div>
          <div>
            <div class="stat-value">${discount}%</div>
            <div class="stat-label">Avg discount</div>
          </div>
        </div>
      </div>
      ${s.top_items.length ? `
        <div class="top-items">
          <h4>Top sellers</h4>
          ${s.top_items.map(i => `
            <div class="top-item">
              <span>${i.item_label}</span>
              <span>$${i.sold_price_usd}</span>
            </div>`).join('')}
        </div>` : ''}
    `;
  } catch {
    content.innerHTML = '<p class="history-empty">Could not load summary.<br>Check your connection.</p>';
  }
}

function initHistory() {
  document.getElementById('history-back-btn').addEventListener('click', () => showView('view-capture'));
  document.getElementById('history-refresh-btn').addEventListener('click', loadHistory);
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
function init() {
  if (!crypto.subtle) {
    document.getElementById('no-crypto-banner').classList.remove('hidden');
    return;
  }

  initSetup();
  initCapture();
  initResult();
  initHistory();

  showView(cfg.ok ? 'view-capture' : 'view-setup');
}

document.addEventListener('DOMContentLoaded', init);
