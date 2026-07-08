/* ===================== しらべ帳: レシート取込モジュール ===================== */

/* ---------------- IndexedDB: 領収書画像の保存 ---------------- */
const RECEIPT_DB_NAME = 'shirabecho_receipts';
const RECEIPT_DB_VERSION = 1;
const RECEIPT_STORE = 'receipts';

function openReceiptDB() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) { reject(new Error('このブラウザはIndexedDBに対応していません')); return; }
    const req = indexedDB.open(RECEIPT_DB_NAME, RECEIPT_DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(RECEIPT_STORE)) db.createObjectStore(RECEIPT_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function saveReceiptImage(id, dataUrl) {
  const db = await openReceiptDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(RECEIPT_STORE, 'readwrite');
    tx.objectStore(RECEIPT_STORE).put(dataUrl, id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function getReceiptImage(id) {
  const db = await openReceiptDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(RECEIPT_STORE, 'readonly');
    const req = tx.objectStore(RECEIPT_STORE).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}
async function deleteReceiptImage(id) {
  const db = await openReceiptDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(RECEIPT_STORE, 'readwrite');
    tx.objectStore(RECEIPT_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function clearAllReceipts() {
  const db = await openReceiptDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(RECEIPT_STORE, 'readwrite');
    tx.objectStore(RECEIPT_STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/* ---------------- 外部ライブラリの遅延読み込み ---------------- */
function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('ライブラリの読み込みに失敗しました: ' + src));
    document.head.appendChild(s);
  });
}
async function ensureTesseract() {
  if (window.Tesseract) return;
  await loadScriptOnce('https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/5.0.4/tesseract.min.js');
}
async function ensurePdfJs() {
  if (window.pdfjsLib) return;
  await loadScriptOnce('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js');
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

/* ---------------- ファイル -> canvas ---------------- */
function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}
function loadImageEl(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}
async function fileToCanvas(file) {
  if (file.type === 'application/pdf') {
    await ensurePdfJs();
    const buf = await file.arrayBuffer();
    const pdf = await window.pdfjsLib.getDocument({ data: buf }).promise;
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    return canvas;
  }
  const dataUrl = await fileToDataUrl(file);
  const img = await loadImageEl(dataUrl);
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  canvas.getContext('2d').drawImage(img, 0, 0);
  return canvas;
}
function compressCanvasToDataUrl(canvas, maxWidth, quality) {
  let { width, height } = canvas;
  if (width > maxWidth) {
    height = Math.round(height * maxWidth / width);
    width = maxWidth;
  }
  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  out.getContext('2d').drawImage(canvas, 0, 0, width, height);
  return out.toDataURL('image/jpeg', quality);
}

/* ---------------- オフラインOCR ---------------- */
async function runOfflineOCR(canvas) {
  await ensureTesseract();
  const { data } = await window.Tesseract.recognize(canvas, 'jpn+eng');
  return data.text || '';
}

/* ---------------- テキスト解析(日付・金額・店名・科目推定) ---------------- */
function eraToDate(era, yStr, m, d) {
  const y = (yStr === '元') ? 1 : parseInt(yStr, 10);
  let year;
  if (era === '令和') year = y + 2018;
  else if (era === '平成') year = y + 1988;
  else if (era === '昭和') year = y + 1925;
  else return null;
  return `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
function parseDateFromText(text) {
  let m = text.match(/(20\d{2})[年\/\-.](\d{1,2})[月\/\-.](\d{1,2})/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  m = text.match(/令和\s*(元|\d{1,2})年\s*(\d{1,2})月\s*(\d{1,2})日/);
  if (m) return eraToDate('令和', m[1], m[2], m[3]);
  m = text.match(/平成\s*(元|\d{1,2})年\s*(\d{1,2})月\s*(\d{1,2})日/);
  if (m) return eraToDate('平成', m[1], m[2], m[3]);
  return null;
}
function parseAmountFromText(text) {
  const lines = text.split(/\n/);
  const kw = ['合計', 'ご利用金額', 'お会計', '総額', '税込合計', 'TOTAL', 'Total'];
  for (const line of lines) {
    if (kw.some(k => line.includes(k))) {
      const nm = line.match(/([0-9][0-9,]{2,})/);
      if (nm) { const v = parseInt(nm[1].replace(/,/g, ''), 10); if (v > 0) return v; }
    }
  }
  const withComma = Array.from(text.matchAll(/([0-9]{1,3}(?:,[0-9]{3})+)/g)).map(x => parseInt(x[1].replace(/,/g, ''), 10));
  if (withComma.length) return Math.max(...withComma);
  const withYen = Array.from(text.matchAll(/([0-9]{3,6})\s*円/g)).map(x => parseInt(x[1], 10));
  if (withYen.length) return Math.max(...withYen);
  return null;
}
function parseStoreFromText(text) {
  const lines = text.split(/\n/).map(l => l.trim()).filter(Boolean);
  return lines.length ? lines[0].slice(0, 30) : '';
}
const RECEIPT_CATEGORY_KEYWORDS = {
  travel: ['ガソリン', 'ENEOS', '出光', 'コスモ石油', 'タクシー', '駐車場', '高速道路', 'ETC', 'JR', '鉄道', 'バス', 'パーキング'],
  freight: ['ヤマト運輸', '佐川急便', '日本郵便', 'ゆうパック', '宅急便', '配送料', '運送'],
  supplies: ['ケーズデンキ', 'ヨドバシ', 'コーナン', 'カインズ', '文房具', 'ホームセンター', '工具', '事務用品', 'ダイソー', 'コメリ'],
  utilities: ['電力', '東京電力', '関西電力', '中部電力', 'ガス', '水道局', '東京ガス', '大阪ガス'],
  comm: ['ドコモ', 'NTT', 'au', 'ソフトバンク', 'KDDI', '携帯電話', 'インターネット', 'プロバイダ', 'Wi-Fi'],
  insurance: ['損害保険', '自動車保険', '火災保険', '共済', '保険料'],
  repair: ['車検', '整備', '修理', 'タイヤ館', 'オートバックス', 'イエローハット'],
  entertainment: ['居酒屋', 'レストラン', '宴会', '接待', 'ホテル宴'],
  ad: ['広告', '印刷', 'チラシ', '名刺'],
  tax: ['収入印紙', '印紙税', '自動車税', '固定資産税', '税務署'],
};
function guessCategoryFromText(text) {
  let best = 'misc', bestScore = 0;
  for (const [catId, kws] of Object.entries(RECEIPT_CATEGORY_KEYWORDS)) {
    let score = 0;
    kws.forEach(k => { if (text.includes(k)) score++; });
    if (score > bestScore) { bestScore = score; best = catId; }
  }
  return best;
}
function parseReceiptText(text) {
  return {
    date: parseDateFromText(text),
    amount: parseAmountFromText(text),
    store: parseStoreFromText(text),
    memo: parseStoreFromText(text),
    catId: guessCategoryFromText(text),
  };
}

/* ---------------- AI(Claude API)による読み取り ---------------- */
async function runAiExtraction(imageDataUrl, apiKey, model) {
  const base64 = imageDataUrl.split(',')[1];
  const catIds = EXPENSE_CATEGORIES.map(c => c.id).join(',');
  const prompt = `あなたは日本の個人事業主の経理担当です。添付されたレシート/領収書の画像を読み取り、次のJSON形式のみで出力してください。説明文やコードブロックの記号は一切含めないでください。
{"date":"YYYY-MM-DD形式の取引日、不明ならnull","amount":合計金額の数値(カンマなし、不明ならnull),"store":"店舗名・支払先(不明なら空文字)","memo":"品目や用途を20文字以内で要約","category_id":"次のいずれか1つを選択: ${catIds}"}
category_idは経費の内容から最も適切なものを選んでください。判断が難しい場合は misc としてください。`;

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: model || 'claude-sonnet-5',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } },
          { type: 'text', text: prompt },
        ],
      }],
    }),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`API error ${resp.status}: ${errText.slice(0, 200)}`);
  }
  const data = await resp.json();
  const textBlock = (data.content || []).find(b => b.type === 'text');
  if (!textBlock) throw new Error('AIの応答からテキストを取得できませんでした');
  let jsonStr = textBlock.text.trim();
  jsonStr = jsonStr.replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();
  const parsed = JSON.parse(jsonStr);
  return {
    date: parsed.date || null,
    amount: (parsed.amount !== undefined && parsed.amount !== null) ? Number(parsed.amount) : null,
    store: parsed.store || '',
    memo: parsed.memo || parsed.store || '',
    catId: CAT_MAP[parsed.category_id] ? parsed.category_id : 'misc',
  };
}

/* ---------------- 取込フロー(モーダルUI) ---------------- */
function openReceiptImportModal() {
  renderModal(`
    <h3>レシートを取り込む</h3>
    <p class="help">画像(JPEG/PNG)またはPDFのレシートを選択してください。内容を自動で読み取り、取引の入力画面に反映します。</p>
    <input type="file" id="receiptFile" accept="image/*,application/pdf">
    <p class="help" id="receiptStatus" style="margin-top:10px;"></p>
    <div class="modal-footer"><button class="btn" id="receiptCancel">閉じる</button></div>
  `);
  document.getElementById('receiptCancel').onclick = closeModal;
  document.getElementById('receiptFile').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const statusEl = document.getElementById('receiptStatus');
    const useAi = !!(state.receiptSettings.useAi && state.receiptSettings.apiKey);
    statusEl.textContent = useAi ? 'AIで解析しています…' : 'オフラインOCRで解析しています(初回は認識辞書のダウンロードのため時間がかかることがあります)…';
    try {
      const canvas = await fileToCanvas(file);
      const imageDataUrl = compressCanvasToDataUrl(canvas, 1400, 0.75);
      let extracted = null;
      let mode = 'offline';
      if (useAi) {
        try {
          extracted = await runAiExtraction(imageDataUrl, state.receiptSettings.apiKey, state.receiptSettings.model);
          mode = 'ai';
        } catch (err) {
          console.warn('AI解析に失敗、オフラインOCRに切替', err);
          statusEl.textContent = 'AI解析に失敗したため、オフラインOCRに切り替えます…';
        }
      }
      if (!extracted) {
        const text = await runOfflineOCR(canvas);
        extracted = parseReceiptText(text);
      }
      closeModal();
      openReceiptReviewModal(imageDataUrl, extracted, mode);
    } catch (err) {
      console.error(err);
      statusEl.textContent = '解析に失敗しました: ' + err.message;
    }
  };
}

function openReceiptReviewModal(imageDataUrl, extracted, mode) {
  renderModal(`
    <h3>内容の確認</h3>
    <p class="help">${mode === 'ai' ? 'AIで読み取りました。内容を確認して保存してください。' : 'オフラインOCRで読み取りました(簡易的な認識です)。内容を確認・修正のうえ保存してください。'}</p>
    <img src="${imageDataUrl}" style="max-width:100%;max-height:260px;border-radius:6px;border:1px solid var(--grid-strong);margin-bottom:10px;display:block;">
    <label>区分</label>
    <select id="rType"><option value="expense" selected>経費(支出)</option><option value="income">収入</option></select>
    <div class="field-row">
      <div><label>日付</label><input type="date" id="rDate" value="${extracted.date || todayStr()}"></div>
      <div><label>金額(円)</label><input type="number" id="rAmount" min="0" value="${extracted.amount ?? ''}"></div>
    </div>
    <label>科目</label>
    <select id="rCat"></select>
    <div id="rRatioWrap" class="hidden">
      <label>事業使用割合(%)</label>
      <input type="number" id="rRatio" min="0" max="100">
    </div>
    <label>摘要・メモ</label>
    <input type="text" id="rMemo" value="${escapeHtml(extracted.store || extracted.memo || '')}">
    <div class="modal-footer">
      <button class="btn" id="rCancel">破棄</button>
      <button class="btn btn-primary" id="rSave">この内容で保存</button>
    </div>
  `);
  const typeSel = document.getElementById('rType');
  const catSel = document.getElementById('rCat');
  function fillCats() {
    const list = typeSel.value === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
    const defaultCat = list.some(c => c.id === extracted.catId) ? extracted.catId : list[0].id;
    catSel.innerHTML = list.map(c => `<option value="${c.id}" ${defaultCat === c.id ? 'selected' : ''}>${c.name}</option>`).join('');
    toggleRatio();
  }
  function toggleRatio() {
    const cat = CAT_MAP[catSel.value];
    const wrap = document.getElementById('rRatioWrap');
    if (cat && cat.ratio) {
      wrap.classList.remove('hidden');
      const inp = document.getElementById('rRatio');
      if (!inp.value) inp.value = defaultRatio(catSel.value);
    } else {
      wrap.classList.add('hidden');
    }
  }
  typeSel.onchange = fillCats;
  catSel.onchange = toggleRatio;
  fillCats();

  document.getElementById('rCancel').onclick = closeModal;
  document.getElementById('rSave').onclick = async () => {
    const date = document.getElementById('rDate').value;
    const amount = Number(document.getElementById('rAmount').value);
    const catId = catSel.value;
    const memo = document.getElementById('rMemo').value.trim();
    if (!date || !amount) { alert('日付と金額を入力してください'); return; }
    const cat = CAT_MAP[catId];
    const ratio = cat.ratio ? Number(document.getElementById('rRatio').value || 100) : undefined;
    const id = uid();
    const tx = { id, date, amount, catId, memo, type: typeSel.value, ratio, hasReceipt: true };
    state.transactions.push(tx);
    saveState();
    try { await saveReceiptImage(id, imageDataUrl); } catch (e) { console.error('領収書の保存に失敗', e); }
    closeModal();
    currentYear = new Date(date).getFullYear();
    renderAll();
    toast('取引を保存しました');
  };
}
