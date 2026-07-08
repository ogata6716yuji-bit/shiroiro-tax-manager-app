/* ===================== しらべ帳: 白色申告 収支管理 ===================== */

const STORAGE_KEY = 'shirabecho_v1';

const INCOME_CATEGORIES = [
  { id: 'sales', name: '売上(保守点検料等)' },
  { id: 'other_income', name: '雑収入' },
];

// 白色申告「収支内訳書」の経費科目と同じ並び順
const EXPENSE_CATEGORIES = [
  { id: 'tax',           name: '租税公課',   ratio: false },
  { id: 'freight',       name: '荷造運賃',   ratio: false },
  { id: 'utilities',     name: '水道光熱費', ratio: true, defaultRatio: 30 },
  { id: 'travel',        name: '旅費交通費', ratio: false },
  { id: 'comm',          name: '通信費',     ratio: true, defaultRatio: 50 },
  { id: 'ad',            name: '広告宣伝費', ratio: false },
  { id: 'entertainment', name: '接待交際費', ratio: false },
  { id: 'insurance',     name: '損害保険料', ratio: true, defaultRatio: 50 },
  { id: 'repair',        name: '修繕費',     ratio: false },
  { id: 'supplies',      name: '消耗品費',   ratio: false },
  { id: 'depreciation',  name: '減価償却費', ratio: false, auto: true },
  { id: 'welfare',       name: '福利厚生費', ratio: false },
  { id: 'wages',         name: '給料賃金',   ratio: false },
  { id: 'outsourcing',   name: '外注工賃',   ratio: false },
  { id: 'interest',      name: '利子割引料', ratio: false },
  { id: 'rent',          name: '地代家賃',   ratio: true, defaultRatio: 50 },
  { id: 'baddebt',       name: '貸倒金',     ratio: false },
  { id: 'misc',          name: '雑費',       ratio: false },
];

function allCategoryMap() {
  const m = {};
  INCOME_CATEGORIES.forEach(c => m[c.id] = { ...c, type: 'income' });
  EXPENSE_CATEGORIES.forEach(c => m[c.id] = { ...c, type: 'expense' });
  return m;
}
const CAT_MAP = allCategoryMap();

/* ---------------- storage ---------------- */
function loadState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  const base = {
    profile: { name: '', tradeName: '', address: '', tel: '' },
    transactions: [],   // {id,date,type,catId,memo,amount,ratio,hasReceipt}
    assets: [],         // {id,name,acqDate,price,usefulLife,ratio}
    ratios: {},          // catId -> default ratio %
    inventory: {},        // year -> {start,purchase,end}
    receiptSettings: { apiKey: '', model: 'claude-sonnet-5', useAi: false }
  };
  if (!raw) return base;
  try {
    const parsed = JSON.parse(raw);
    return { ...base, ...parsed };
  } catch (e) {
    console.warn('state parse failed, resetting', e);
    return base;
  }
}
function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

let state = loadState();
let currentYear = new Date().getFullYear();
let currentTab = 'dashboard';

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function yen(n) { return '¥' + Math.round(n || 0).toLocaleString('ja-JP'); }
function defaultRatio(catId) {
  if (state.ratios[catId] !== undefined) return state.ratios[catId];
  const c = CAT_MAP[catId];
  return c && c.defaultRatio !== undefined ? c.defaultRatio : 100;
}

/* ---------------- depreciation ---------------- */
function depreciationSchedule(asset) {
  const acq = new Date(asset.acqDate);
  const acqYear = acq.getFullYear();
  const acqMonth = acq.getMonth() + 1;
  const life = Math.max(1, Number(asset.usefulLife) || 1);
  const rate = Math.round((1 / life) * 1000) / 1000;
  const annual = Math.round(asset.price * rate);
  let remaining = Math.max(asset.price - 1, 0); // 備忘価額1円まで
  const schedule = [];
  let year = acqYear;
  let monthsThisYear = 12 - acqMonth + 1;
  let first = true;
  while (remaining > 0 && schedule.length < 60) {
    let amt = first ? Math.round(annual * monthsThisYear / 12) : annual;
    if (amt > remaining) amt = remaining;
    if (amt <= 0) break;
    schedule.push({ year, amount: amt });
    remaining -= amt;
    year++;
    first = false;
  }
  return schedule;
}
function assetAmountForYear(asset, year) {
  const s = depreciationSchedule(asset).find(x => x.year === year);
  return s ? s.amount : 0;
}
function totalDepreciationForYear(year) {
  let total = 0, business = 0;
  state.assets.forEach(a => {
    const amt = assetAmountForYear(a, year);
    total += amt;
    business += Math.round(amt * (a.ratio ?? 100) / 100);
  });
  return { total, business };
}

/* ---------------- aggregation ---------------- */
function transactionsForYear(year) {
  return state.transactions.filter(t => new Date(t.date).getFullYear() === year);
}
function businessAmount(t) {
  const cat = CAT_MAP[t.catId];
  if (!cat || !cat.ratio) return t.amount;
  const r = t.ratio !== undefined && t.ratio !== null ? t.ratio : defaultRatio(t.catId);
  return Math.round(t.amount * r / 100);
}
function yearSummary(year) {
  const txs = transactionsForYear(year);
  let income = 0;
  const expenseByCategory = {};
  EXPENSE_CATEGORIES.forEach(c => expenseByCategory[c.id] = 0);
  txs.forEach(t => {
    if (t.type === 'income') income += t.amount;
    else expenseByCategory[t.catId] = (expenseByCategory[t.catId] || 0) + businessAmount(t);
  });
  const dep = totalDepreciationForYear(year);
  expenseByCategory['depreciation'] = dep.business;

  const inv = state.inventory[year] || { start: 0, purchase: 0, end: 0 };
  const cogs = Math.max(0, (Number(inv.start) || 0) + (Number(inv.purchase) || 0) - (Number(inv.end) || 0));

  let expenseTotal = 0;
  EXPENSE_CATEGORIES.forEach(c => expenseTotal += expenseByCategory[c.id] || 0);

  const grossIncome = income - cogs;
  const profit = grossIncome - expenseTotal;
  return { income, expenseByCategory, expenseTotal, cogs, grossIncome, profit, inv };
}

/* ---------------- init / render root ---------------- */
function populateYearSelect() {
  const sel = document.getElementById('yearSelect');
  const years = new Set([currentYear]);
  state.transactions.forEach(t => years.add(new Date(t.date).getFullYear()));
  state.assets.forEach(a => years.add(new Date(a.acqDate).getFullYear()));
  const sorted = Array.from(years).sort((a, b) => b - a);
  sel.innerHTML = sorted.map(y => `<option value="${y}" ${y === currentYear ? 'selected' : ''}>${y}年分</option>`).join('');
  sel.onchange = () => { currentYear = Number(sel.value); renderAll(); };
}

function updateGauges() {
  const s = yearSummary(currentYear);
  document.getElementById('gaugeIncome').textContent = yen(s.income);
  document.getElementById('gaugeExpense').textContent = yen(s.expenseTotal + s.cogs);
  const profitEl = document.getElementById('gaugeProfit');
  profitEl.textContent = yen(s.profit);
  profitEl.className = 'gauge-value ' + (s.profit >= 0 ? 'plus' : 'minus');
}

const TABS = [
  { id: 'dashboard', label: 'ダッシュボード' },
  { id: 'transactions', label: '取引入力' },
  { id: 'assets', label: '固定資産・減価償却' },
  { id: 'ratios', label: '按分・事業者情報' },
  { id: 'report', label: '申告書出力' },
  { id: 'data', label: 'データ管理' },
];

function renderTabs() {
  const el = document.getElementById('tabs');
  el.innerHTML = TABS.map(t =>
    `<button class="tab-btn ${t.id === currentTab ? 'active' : ''}" data-tab="${t.id}">${t.label}</button>`
  ).join('');
  el.querySelectorAll('.tab-btn').forEach(btn => {
    btn.onclick = () => { currentTab = btn.dataset.tab; renderAll(); };
  });
}

function renderAll() {
  populateYearSelect();
  updateGauges();
  renderTabs();
  const main = document.getElementById('main');
  if (currentTab === 'dashboard') main.innerHTML = renderDashboard();
  else if (currentTab === 'transactions') { main.innerHTML = renderTransactions(); bindTransactionsTab(); }
  else if (currentTab === 'assets') { main.innerHTML = renderAssets(); bindAssetsTab(); }
  else if (currentTab === 'ratios') { main.innerHTML = renderRatios(); bindRatiosTab(); }
  else if (currentTab === 'report') { main.innerHTML = renderReport(); bindReportTab(); }
  else if (currentTab === 'data') { main.innerHTML = renderData(); bindDataTab(); }
  if (currentTab === 'dashboard') bindDashboard();
}

/* ---------------- Dashboard ---------------- */
function renderDashboard() {
  const s = yearSummary(currentYear);
  const rows = EXPENSE_CATEGORIES.map(c => {
    const amt = s.expenseByCategory[c.id] || 0;
    if (amt === 0) return '';
    const pct = s.expenseTotal ? (amt / s.expenseTotal * 100) : 0;
    return `<tr><td>${c.name}</td><td class="num">${yen(amt)}</td>
      <td><div style="background:var(--grid);border-radius:4px;overflow:hidden;height:8px;">
      <div style="width:${pct.toFixed(1)}%;background:var(--amber);height:8px;"></div></div></td></tr>`;
  }).join('');

  return `
  <div class="grid-3">
    <div class="stat-card"><div class="lbl">${currentYear}年 取引件数</div><div class="val">${transactionsForYear(currentYear).length}件</div></div>
    <div class="stat-card"><div class="lbl">売上原価</div><div class="val">${yen(s.cogs)}</div></div>
    <div class="stat-card"><div class="lbl">登録資産数</div><div class="val">${state.assets.length}件</div></div>
  </div>
  <div class="panel">
    <h2>経費科目の内訳(事業分)</h2>
    ${rows ? `<table><thead><tr><th>科目</th><th class="num">金額</th><th>構成比</th></tr></thead><tbody>${rows}</tbody></table>`
      : `<div class="empty-state"><div class="big">まだ経費データがありません</div>「取引入力」タブから登録しましょう</div>`}
  </div>
  <div class="panel">
    <h2>最近の取引</h2>
    ${renderRecentTable()}
  </div>`;
}
function renderRecentTable() {
  const txs = transactionsForYear(currentYear).slice().sort((a, b) => b.date.localeCompare(a.date)).slice(0, 8);
  if (!txs.length) return `<div class="empty-state">データなし</div>`;
  return `<table><thead><tr><th>日付</th><th>区分</th><th>科目</th><th>摘要</th><th class="num">金額</th></tr></thead><tbody>
    ${txs.map(t => `<tr>
      <td class="num">${t.date}</td>
      <td><span class="tag ${t.type === 'income' ? 'income' : ''}">${t.type === 'income' ? '収入' : '経費'}</span></td>
      <td>${CAT_MAP[t.catId]?.name || ''}</td>
      <td>${escapeHtml(t.memo || '')}</td>
      <td class="num ${t.type === 'income' ? 'amt-plus' : 'amt-minus'}">${yen(t.amount)}</td>
    </tr>`).join('')}
  </tbody></table>`;
}
function bindDashboard() {}

/* ---------------- Transactions ---------------- */
let txFilter = { month: 'all', type: 'all' };

function renderTransactions() {
  const txs = transactionsForYear(currentYear)
    .filter(t => txFilter.month === 'all' || (new Date(t.date).getMonth() + 1) === Number(txFilter.month))
    .filter(t => txFilter.type === 'all' || t.type === txFilter.type)
    .slice().sort((a, b) => b.date.localeCompare(a.date));

  const monthOptions = Array.from({ length: 12 }, (_, i) => i + 1)
    .map(m => `<option value="${m}" ${txFilter.month == m ? 'selected' : ''}>${m}月</option>`).join('');

  const rows = txs.map(t => `
    <tr>
      <td class="num">${t.date}</td>
      <td><span class="tag ${t.type === 'income' ? 'income' : ''}">${t.type === 'income' ? '収入' : '経費'}</span></td>
      <td>${CAT_MAP[t.catId]?.name || ''}</td>
      <td>${escapeHtml(t.memo || '')}${t.hasReceipt ? ' <span class="tag" title="領収書あり">📎</span>' : ''}</td>
      <td class="num">${yen(t.amount)}</td>
      <td class="num">${CAT_MAP[t.catId]?.ratio ? (t.ratio ?? defaultRatio(t.catId)) + '%' : '100%'}</td>
      <td class="num ${t.type === 'income' ? 'amt-plus' : 'amt-minus'}">${yen(businessAmount(t))}</td>
      <td><button class="btn btn-sm" data-edit="${t.id}">編集</button>
          <button class="btn btn-sm btn-danger" data-del="${t.id}">削除</button></td>
    </tr>`).join('');

  return `
  <div class="panel">
    <div class="actions-row">
      <div class="btn-row">
        <select id="filterMonth"><option value="all">全期間</option>${monthOptions}</select>
        <select id="filterType">
          <option value="all" ${txFilter.type === 'all' ? 'selected' : ''}>収入・経費すべて</option>
          <option value="income" ${txFilter.type === 'income' ? 'selected' : ''}>収入のみ</option>
          <option value="expense" ${txFilter.type === 'expense' ? 'selected' : ''}>経費のみ</option>
        </select>
      </div>
      <div class="btn-row">
        <button class="btn" id="importReceiptBtn">📷 レシートから取込</button>
        <button class="btn btn-primary" id="addTxBtn">＋ 取引を追加</button>
      </div>
    </div>
    ${rows ? `<table><thead><tr><th>日付</th><th>区分</th><th>科目</th><th>摘要</th><th class="num">金額</th><th class="num">事業割合</th><th class="num">事業分</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table>` : `<div class="empty-state"><div class="big">取引がありません</div>右上の「＋ 取引を追加」または「📷 レシートから取込」から登録してください</div>`}
  </div>`;
}

function bindTransactionsTab() {
  document.getElementById('filterMonth').onchange = e => { txFilter.month = e.target.value; renderAll(); };
  document.getElementById('filterType').onchange = e => { txFilter.type = e.target.value; renderAll(); };
  document.getElementById('addTxBtn').onclick = () => openTransactionModal();
  document.getElementById('importReceiptBtn').onclick = () => openReceiptImportModal();
  document.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => openTransactionModal(b.dataset.edit));
  document.querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
    if (confirm('この取引を削除しますか?')) {
      const target = state.transactions.find(t => t.id === b.dataset.del);
      state.transactions = state.transactions.filter(t => t.id !== b.dataset.del);
      saveState();
      if (target && target.hasReceipt) deleteReceiptImage(target.id).catch(() => {});
      renderAll();
    }
  });
}

function openTransactionModal(editId) {
  const editing = editId ? state.transactions.find(t => t.id === editId) : null;
  const type = editing?.type || 'expense';
  renderModal(`
    <h3>${editing ? '取引を編集' : '取引を追加'}</h3>
    <label>区分</label>
    <select id="mType">
      <option value="expense" ${type === 'expense' ? 'selected' : ''}>経費(支出)</option>
      <option value="income" ${type === 'income' ? 'selected' : ''}>収入</option>
    </select>
    <div class="field-row">
      <div><label>日付</label><input type="date" id="mDate" value="${editing?.date || todayStr()}"></div>
      <div><label>金額(円)</label><input type="number" id="mAmount" min="0" value="${editing?.amount ?? ''}"></div>
    </div>
    <label>科目</label>
    <select id="mCat"></select>
    <div id="mRatioWrap" class="hidden">
      <label>事業使用割合(%) <span class="help">家事按分。プライベート兼用分を除いた事業用の割合</span></label>
      <input type="number" id="mRatio" min="0" max="100" value="${editing?.ratio ?? ''}">
    </div>
    <label>摘要・メモ</label>
    <input type="text" id="mMemo" value="${escapeHtml(editing?.memo || '')}" placeholder="例:A工場 定期点検料">
    <div id="mReceiptWrap">${editing?.hasReceipt ? '<label>領収書</label><div id="mReceiptPreview" class="help">読み込み中…</div>' : ''}</div>
    <div class="modal-footer">
      <button class="btn" id="mCancel">キャンセル</button>
      <button class="btn btn-primary" id="mSave">保存</button>
    </div>
  `);

  if (editing?.hasReceipt) {
    getReceiptImage(editing.id).then(dataUrl => {
      const wrap = document.getElementById('mReceiptPreview');
      if (!wrap) return;
      if (dataUrl) {
        wrap.innerHTML = `<img src="${dataUrl}" style="max-width:100%;max-height:220px;border-radius:6px;border:1px solid var(--grid-strong);display:block;margin-bottom:6px;">
          <button type="button" class="btn btn-sm btn-danger" id="mDeleteReceipt">領収書を削除</button>`;
        document.getElementById('mDeleteReceipt').onclick = async () => {
          if (!confirm('添付されている領収書画像を削除しますか?')) return;
          await deleteReceiptImage(editing.id).catch(() => {});
          editing.hasReceipt = false;
          saveState();
          wrap.innerHTML = '<span class="help">削除しました</span>';
        };
      } else {
        wrap.innerHTML = '<span class="help">画像の読み込みに失敗しました</span>';
      }
    });
  }

  const typeSel = document.getElementById('mType');
  const catSel = document.getElementById('mCat');
  function fillCats() {
    const list = typeSel.value === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
    catSel.innerHTML = list.map(c => `<option value="${c.id}" ${editing?.catId === c.id ? 'selected' : ''}>${c.name}</option>`).join('');
    toggleRatio();
  }
  function toggleRatio() {
    const cat = CAT_MAP[catSel.value];
    const wrap = document.getElementById('mRatioWrap');
    if (cat && cat.ratio) {
      wrap.classList.remove('hidden');
      const input = document.getElementById('mRatio');
      if (!input.value) input.value = defaultRatio(catSel.value);
    } else {
      wrap.classList.add('hidden');
    }
  }
  typeSel.onchange = fillCats;
  catSel.onchange = toggleRatio;
  fillCats();

  document.getElementById('mCancel').onclick = closeModal;
  document.getElementById('mSave').onclick = () => {
    const date = document.getElementById('mDate').value;
    const amount = Number(document.getElementById('mAmount').value);
    const catId = catSel.value;
    const memo = document.getElementById('mMemo').value.trim();
    if (!date || !amount) { alert('日付と金額を入力してください'); return; }
    const cat = CAT_MAP[catId];
    const ratio = cat.ratio ? Number(document.getElementById('mRatio').value || 100) : undefined;
    if (editing) {
      Object.assign(editing, { date, amount, catId, memo, type: typeSel.value, ratio });
    } else {
      state.transactions.push({ id: uid(), date, amount, catId, memo, type: typeSel.value, ratio });
    }
    saveState(); closeModal(); currentYear = new Date(date).getFullYear(); renderAll();
  };
}

/* ---------------- Assets / Depreciation ---------------- */
function renderAssets() {
  const rows = state.assets.map(a => {
    const amt = assetAmountForYear(a, currentYear);
    const biz = Math.round(amt * (a.ratio ?? 100) / 100);
    return `<tr>
      <td>${escapeHtml(a.name)}</td>
      <td class="num">${a.acqDate}</td>
      <td class="num">${yen(a.price)}</td>
      <td class="num">${a.usefulLife}年</td>
      <td class="num">${a.ratio ?? 100}%</td>
      <td class="num">${yen(amt)}</td>
      <td class="num">${yen(biz)}</td>
      <td><button class="btn btn-sm" data-edit-asset="${a.id}">編集</button>
          <button class="btn btn-sm btn-danger" data-del-asset="${a.id}">削除</button></td>
    </tr>`;
  }).join('');
  const dep = totalDepreciationForYear(currentYear);

  return `
  <div class="panel">
    <div class="actions-row">
      <h2 style="margin:0;">固定資産(10万円以上)・減価償却</h2>
      <button class="btn btn-primary" id="addAssetBtn">＋ 資産を追加</button>
    </div>
    <p class="help">耐用年数は国税庁「耐用年数表」を参照してください。償却方法は定額法(簡易計算)、備忘価額1円まで償却します。</p>
    ${rows ? `<table><thead><tr><th>資産名</th><th class="num">取得日</th><th class="num">取得価額</th><th class="num">耐用年数</th><th class="num">事業割合</th><th class="num">${currentYear}年 償却費</th><th class="num">事業分</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table>` : `<div class="empty-state"><div class="big">登録資産がありません</div>PCや測定器具、車両など10万円以上の資産があれば登録してください</div>`}
    <div class="stat-card" style="margin-top:14px;max-width:280px;">
      <div class="lbl">${currentYear}年 減価償却費(事業分)</div>
      <div class="val">${yen(dep.business)}</div>
    </div>
  </div>`;
}
function bindAssetsTab() {
  document.getElementById('addAssetBtn').onclick = () => openAssetModal();
  document.querySelectorAll('[data-edit-asset]').forEach(b => b.onclick = () => openAssetModal(b.dataset.editAsset));
  document.querySelectorAll('[data-del-asset]').forEach(b => b.onclick = () => {
    if (confirm('この資産を削除しますか?')) {
      state.assets = state.assets.filter(a => a.id !== b.dataset.delAsset);
      saveState(); renderAll();
    }
  });
}
function openAssetModal(editId) {
  const editing = editId ? state.assets.find(a => a.id === editId) : null;
  renderModal(`
    <h3>${editing ? '資産を編集' : '資産を追加'}</h3>
    <label>資産名</label>
    <input type="text" id="aName" value="${escapeHtml(editing?.name || '')}" placeholder="例:振動測定器">
    <div class="field-row">
      <div><label>取得日</label><input type="date" id="aDate" value="${editing?.acqDate || todayStr()}"></div>
      <div><label>取得価額(円)</label><input type="number" id="aPrice" min="0" value="${editing?.price ?? ''}"></div>
    </div>
    <div class="field-row">
      <div><label>耐用年数(年)</label><input type="number" id="aLife" min="1" value="${editing?.usefulLife ?? ''}"></div>
      <div><label>事業使用割合(%)</label><input type="number" id="aRatio" min="0" max="100" value="${editing?.ratio ?? 100}"></div>
    </div>
    <div class="modal-footer">
      <button class="btn" id="aCancel">キャンセル</button>
      <button class="btn btn-primary" id="aSave">保存</button>
    </div>
  `);
  document.getElementById('aCancel').onclick = closeModal;
  document.getElementById('aSave').onclick = () => {
    const name = document.getElementById('aName').value.trim();
    const acqDate = document.getElementById('aDate').value;
    const price = Number(document.getElementById('aPrice').value);
    const usefulLife = Number(document.getElementById('aLife').value);
    const ratio = Number(document.getElementById('aRatio').value || 100);
    if (!name || !acqDate || !price || !usefulLife) { alert('すべての項目を入力してください'); return; }
    if (editing) Object.assign(editing, { name, acqDate, price, usefulLife, ratio });
    else state.assets.push({ id: uid(), name, acqDate, price, usefulLife, ratio });
    saveState(); closeModal(); renderAll();
  };
}

/* ---------------- Ratios / Profile ---------------- */
function renderRatios() {
  const ratioCats = EXPENSE_CATEGORIES.filter(c => c.ratio);
  return `
  <div class="panel">
    <h2>事業者情報</h2>
    <p class="help">収支内訳書の作成に使用します。</p>
    <div class="grid-2">
      <div><label>氏名</label><input type="text" id="pName" value="${escapeHtml(state.profile.name)}"></div>
      <div><label>屋号(あれば)</label><input type="text" id="pTrade" value="${escapeHtml(state.profile.tradeName)}"></div>
    </div>
    <div class="grid-2">
      <div><label>納税地(住所)</label><input type="text" id="pAddress" value="${escapeHtml(state.profile.address)}"></div>
      <div><label>電話番号</label><input type="text" id="pTel" value="${escapeHtml(state.profile.tel)}"></div>
    </div>
    <div class="modal-footer" style="justify-content:flex-start;">
      <button class="btn btn-primary" id="saveProfile">事業者情報を保存</button>
    </div>
  </div>
  <div class="panel">
    <h2>家事按分デフォルト設定</h2>
    <p class="help">自宅を事務所として使用している場合の、経費科目ごとの標準の事業使用割合です。取引ごとに個別調整も可能です。</p>
    <table><thead><tr><th>科目</th><th class="num">標準事業割合(%)</th></tr></thead><tbody>
      ${ratioCats.map(c => `<tr><td>${c.name}</td><td class="num"><input type="number" min="0" max="100" style="width:90px;text-align:right;" data-ratio-cat="${c.id}" value="${defaultRatio(c.id)}"></td></tr>`).join('')}
    </tbody></table>
    <div class="modal-footer" style="justify-content:flex-start;">
      <button class="btn btn-primary" id="saveRatios">按分設定を保存</button>
    </div>
  </div>
  <div class="panel">
    <h2>レシート自動取込設定</h2>
    <p class="help">「取引入力」タブの「📷 レシートから取込」で使用します。標準ではオフラインOCR(端末内で処理・無料)で読み取ります。Claude APIキーを設定してAIモードを有効にすると、より高精度に日付・金額・科目を読み取れます(画像がAnthropicのAPIに送信されます。通信費が発生します)。</p>
    <label><input type="checkbox" id="rsUseAi" ${state.receiptSettings.useAi ? 'checked' : ''}> AIモードを使う(要APIキー)</label>
    <label>Claude APIキー</label>
    <input type="text" id="rsApiKey" value="${escapeHtml(state.receiptSettings.apiKey || '')}" placeholder="sk-ant-...">
    <label>モデル名</label>
    <input type="text" id="rsModel" value="${escapeHtml(state.receiptSettings.model || 'claude-sonnet-5')}">
    <p class="help">APIキーはこの端末のブラウザ内にのみ保存され、外部には送信されません(領収書画像を読み取る際にAnthropicへ直接送信されます)。</p>
    <div class="modal-footer" style="justify-content:flex-start;">
      <button class="btn btn-primary" id="saveReceiptSettings">レシート取込設定を保存</button>
    </div>
  </div>
  <div class="panel">
    <h2>棚卸(仕入がある場合のみ)</h2>
    <p class="help">部品などの在庫を仕入れて使う場合のみ入力してください。無ければ0のままでOKです。(${currentYear}年分)</p>
    <div class="grid-3">
      <div><label>期首棚卸高</label><input type="number" id="invStart" value="${state.inventory[currentYear]?.start ?? 0}"></div>
      <div><label>仕入高</label><input type="number" id="invPurchase" value="${state.inventory[currentYear]?.purchase ?? 0}"></div>
      <div><label>期末棚卸高</label><input type="number" id="invEnd" value="${state.inventory[currentYear]?.end ?? 0}"></div>
    </div>
    <div class="modal-footer" style="justify-content:flex-start;">
      <button class="btn btn-primary" id="saveInventory">棚卸情報を保存</button>
    </div>
  </div>`;
}
function bindRatiosTab() {
  document.getElementById('saveProfile').onclick = () => {
    state.profile = {
      name: document.getElementById('pName').value.trim(),
      tradeName: document.getElementById('pTrade').value.trim(),
      address: document.getElementById('pAddress').value.trim(),
      tel: document.getElementById('pTel').value.trim(),
    };
    saveState(); toast('事業者情報を保存しました');
  };
  document.getElementById('saveRatios').onclick = () => {
    document.querySelectorAll('[data-ratio-cat]').forEach(inp => {
      state.ratios[inp.dataset.ratioCat] = Number(inp.value);
    });
    saveState(); toast('按分設定を保存しました'); renderAll();
  };
  document.getElementById('saveReceiptSettings').onclick = () => {
    state.receiptSettings = {
      useAi: document.getElementById('rsUseAi').checked,
      apiKey: document.getElementById('rsApiKey').value.trim(),
      model: document.getElementById('rsModel').value.trim() || 'claude-sonnet-5',
    };
    saveState(); toast('レシート取込設定を保存しました');
  };
  document.getElementById('saveInventory').onclick = () => {
    state.inventory[currentYear] = {
      start: Number(document.getElementById('invStart').value || 0),
      purchase: Number(document.getElementById('invPurchase').value || 0),
      end: Number(document.getElementById('invEnd').value || 0),
    };
    saveState(); toast('棚卸情報を保存しました'); renderAll();
  };
}

/* ---------------- Report ---------------- */
function renderReport() {
  const s = yearSummary(currentYear);
  const rows = EXPENSE_CATEGORIES.map(c => `<tr><td>${c.name}</td><td class="num">${yen(s.expenseByCategory[c.id] || 0)}</td></tr>`).join('');
  return `
  <div class="panel">
    <h2>${currentYear}年分 収支内訳書 プレビュー</h2>
    <p class="help">国税庁の「収支内訳書(一般用)」と同じ科目構成で集計しています。PDFはそのまま添付資料として使えますが、正式な申告書への転記(またはe-Taxへの入力)はご自身で行ってください。</p>
    <table>
      <tr><td>①売上(収入)金額</td><td class="num">${yen(s.income)}</td></tr>
      <tr><td>②売上原価</td><td class="num">${yen(s.cogs)}</td></tr>
      <tr class="total-row"><td>差引金額(売上総利益)</td><td class="num">${yen(s.grossIncome)}</td></tr>
    </table>
    <h3 style="margin-top:18px;">経費内訳</h3>
    <table><thead><tr><th>科目</th><th class="num">金額</th></tr></thead><tbody>
      ${rows}
      <tr class="total-row"><td>経費計</td><td class="num">${yen(s.expenseTotal)}</td></tr>
    </tbody></table>
    <table style="margin-top:10px;">
      <tr class="total-row"><td>差引金額(所得金額)</td><td class="num">${yen(s.profit)}</td></tr>
    </table>
    <div class="modal-footer" style="justify-content:flex-start;">
      <button class="btn btn-primary" id="exportPdfBtn">📄 収支内訳書 PDFを作成</button>
    </div>
    <p class="help" id="pdfStatus"></p>
  </div>`;
}
function bindReportTab() {
  document.getElementById('exportPdfBtn').onclick = exportReportPdf;
}

function monthlyBreakdown(year) {
  const months = Array.from({ length: 12 }, () => ({ income: 0, cogs: 0 }));
  transactionsForYear(year).forEach(t => {
    const m = new Date(t.date).getMonth();
    if (t.type === 'income') months[m].income += t.amount;
  });
  return months;
}

async function exportReportPdf() {
  const statusEl = document.getElementById('pdfStatus');
  statusEl.textContent = 'PDFを作成しています…';
  const s = yearSummary(currentYear);
  const months = monthlyBreakdown(currentYear);
  const container = document.getElementById('print-report');

  const page1 = `
  <div class="rpt-page">
    <div class="rpt-title">収 支 内 訳 書 (一般用)</div>
    <div class="rpt-sub">${currentYear}年分 &mdash; しらべ帳による集計資料(白色申告用)</div>
    <div class="rpt-meta">
      <div>氏名: ${escapeHtml(state.profile.name || '未入力')} ${state.profile.tradeName ? '(屋号: ' + escapeHtml(state.profile.tradeName) + ')' : ''}</div>
      <div>作成日: ${todayStr()}</div>
    </div>
    <div style="font-size:11px;margin-bottom:10px;">納税地: ${escapeHtml(state.profile.address || '')} ／ 電話: ${escapeHtml(state.profile.tel || '')}</div>

    <div class="rpt-section-title">収入金額</div>
    <table class="rpt-table">
      <tr><th style="width:70%;">① 売上(収入)金額</th><td class="n">${yen(s.income)}</td></tr>
      <tr><th>② 売上原価(期首棚卸+仕入-期末棚卸)</th><td class="n">${yen(s.cogs)}</td></tr>
      <tr class="rpt-total"><th>差引金額(売上総利益)</th><td class="n">${yen(s.grossIncome)}</td></tr>
    </table>

    <div class="rpt-section-title">経費</div>
    <table class="rpt-table">
      <tr><th style="width:70%;">科目</th><th style="width:30%;">金額</th></tr>
      ${EXPENSE_CATEGORIES.map(c => `<tr><td>${c.name}</td><td class="n">${yen(s.expenseByCategory[c.id] || 0)}</td></tr>`).join('')}
      <tr class="rpt-total"><td>経費計</td><td class="n">${yen(s.expenseTotal)}</td></tr>
    </table>

    <table class="rpt-table">
      <tr class="rpt-total"><th style="width:70%;">差引金額(所得金額)</th><td class="n">${yen(s.profit)}</td></tr>
    </table>
    <p class="rpt-note">※本資料は入力データに基づく自動集計です。金額の最終確認は必ずご自身で行い、正式な申告書(または e-Tax)に転記してください。</p>
  </div>`;

  const rentTxs = transactionsForYear(currentYear).filter(t => t.catId === 'rent');
  const depRows = state.assets.map(a => {
    const amt = assetAmountForYear(a, currentYear);
    const biz = Math.round(amt * (a.ratio ?? 100) / 100);
    const rate = Math.round((1 / Math.max(1, a.usefulLife)) * 1000) / 1000;
    return `<tr>
      <td>${escapeHtml(a.name)}</td><td>${a.acqDate}</td><td class="n">${yen(a.price)}</td>
      <td>${a.usefulLife}年</td><td>定額法</td><td class="n">${rate}</td>
      <td class="n">${yen(amt)}</td><td class="n">${a.ratio ?? 100}%</td><td class="n">${yen(biz)}</td>
    </tr>`;
  }).join('');

  const page2 = `
  <div class="rpt-page">
    <div class="rpt-title" style="font-size:16px;">収支内訳書 付表(内訳明細)</div>
    <div class="rpt-sub">${currentYear}年分</div>

    <div class="rpt-section-title">月別売上金額</div>
    <table class="rpt-table">
      <tr><th>1月</th><th>2月</th><th>3月</th><th>4月</th><th>5月</th><th>6月</th></tr>
      <tr>${months.slice(0, 6).map(m => `<td class="n">${yen(m.income)}</td>`).join('')}</tr>
      <tr><th>7月</th><th>8月</th><th>9月</th><th>10月</th><th>11月</th><th>12月</th></tr>
      <tr>${months.slice(6, 12).map(m => `<td class="n">${yen(m.income)}</td>`).join('')}</tr>
    </table>

    <div class="rpt-section-title">減価償却費の計算</div>
    ${state.assets.length ? `<table class="rpt-table">
      <tr><th>資産名</th><th>取得年月日</th><th>取得価額</th><th>耐用年数</th><th>償却方法</th><th>償却率</th><th>本年分償却費</th><th>事業専用割合</th><th>必要経費算入額</th></tr>
      ${depRows}
    </table>` : `<p class="rpt-note">登録資産なし</p>`}

    <div class="rpt-section-title">地代家賃の内訳</div>
    ${rentTxs.length ? `<table class="rpt-table">
      <tr><th>日付</th><th>摘要</th><th>支払金額</th><th>事業割合</th><th>必要経費算入額</th></tr>
      ${rentTxs.map(t => `<tr><td>${t.date}</td><td>${escapeHtml(t.memo || '')}</td><td class="n">${yen(t.amount)}</td><td class="n">${t.ratio ?? defaultRatio('rent')}%</td><td class="n">${yen(businessAmount(t))}</td></tr>`).join('')}
    </table>` : `<p class="rpt-note">該当データなし</p>`}

    <p class="rpt-note" style="margin-top:20px;">耐用年数・償却率は簡易計算(1/耐用年数)です。国税庁の耐用年数表・償却率表と差異が生じる場合がありますので、正式な申告前にご確認ください。</p>
  </div>`;

  container.innerHTML = page1 + page2;
  await new Promise(r => setTimeout(r, 50));

  try {
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF('p', 'pt', 'a4');
    const pages = container.querySelectorAll('.rpt-page');
    for (let i = 0; i < pages.length; i++) {
      const canvas = await html2canvas(pages[i], { scale: 2, backgroundColor: '#ffffff' });
      const imgData = canvas.toDataURL('image/png');
      const pw = pdf.internal.pageSize.getWidth();
      const ph = pdf.internal.pageSize.getHeight();
      const imgH = pw * canvas.height / canvas.width;
      if (i > 0) pdf.addPage();
      pdf.addImage(imgData, 'PNG', 0, 0, pw, Math.min(imgH, ph));
    }
    pdf.save(`収支内訳書_${currentYear}年分.pdf`);
    statusEl.textContent = 'PDFを保存しました。';
  } catch (e) {
    console.error(e);
    statusEl.textContent = 'PDF作成に失敗しました。通信環境をご確認のうえ再度お試しください。';
  } finally {
    container.innerHTML = '';
  }
}

/* ---------------- Data management ---------------- */
function renderData() {
  return `
  <div class="panel">
    <h2>バックアップ</h2>
    <p class="help">全データ(取引・資産・設定)をJSONファイルとして書き出します。機種変更や万一のデータ消失に備えて定期的に保存してください。</p>
    <label><input type="checkbox" id="exportIncludeReceipts" checked> 領収書画像も含める(ファイルサイズが大きくなります)</label>
    <div style="margin-top:12px;"><button class="btn btn-primary" id="exportJsonBtn">JSONをダウンロード</button></div>
  </div>
  <div class="panel">
    <h2>復元</h2>
    <p class="help">バックアップしたJSONファイルを読み込みます。現在のデータは上書きされます。</p>
    <input type="file" id="importJsonFile" accept="application/json">
    <p class="help" id="importStatus"></p>
  </div>
  <div class="panel">
    <h2 style="color:var(--minus);">データを消去</h2>
    <p class="help">端末内の全データを削除します。この操作は取り消せません。</p>
    <button class="btn btn-danger" id="clearAllBtn">すべてのデータを削除</button>
  </div>`;
}
function bindDataTab() {
  document.getElementById('exportJsonBtn').onclick = async () => {
    const includeReceipts = document.getElementById('exportIncludeReceipts').checked;
    const exportObj = { ...state };
    if (includeReceipts) {
      const receipts = {};
      const targets = state.transactions.filter(t => t.hasReceipt);
      for (const t of targets) {
        try { const img = await getReceiptImage(t.id); if (img) receipts[t.id] = img; } catch (e) { /* skip */ }
      }
      exportObj._receipts = receipts;
    }
    const blob = new Blob([JSON.stringify(exportObj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `しらべ帳_backup_${todayStr()}.json`; a.click();
    URL.revokeObjectURL(url);
  };
  document.getElementById('importJsonFile').onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const statusEl = document.getElementById('importStatus');
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const data = JSON.parse(reader.result);
        if (!confirm('現在のデータを上書きして復元しますか?')) return;
        const receipts = data._receipts || {};
        delete data._receipts;
        state = { profile: {}, transactions: [], assets: [], ratios: {}, inventory: {}, receiptSettings: { apiKey: '', model: 'claude-sonnet-5', useAi: false }, ...data };
        saveState();
        const ids = Object.keys(receipts);
        for (const id of ids) {
          try { await saveReceiptImage(id, receipts[id]); } catch (e) { /* skip */ }
        }
        renderAll();
        toast(`データを復元しました${ids.length ? `(領収書${ids.length}件含む)` : ''}`);
      } catch (err) {
        statusEl.textContent = 'ファイルの読み込みに失敗しました';
      }
    };
    reader.readAsText(file);
  };
  document.getElementById('clearAllBtn').onclick = async () => {
    if (confirm('本当にすべてのデータを削除しますか?この操作は取り消せません。')) {
      localStorage.removeItem(STORAGE_KEY);
      try { await clearAllReceipts(); } catch (e) { /* skip */ }
      state = loadState(); renderAll(); toast('データを削除しました');
    }
  };
}

/* ---------------- helpers: modal, toast, escape ---------------- */
function renderModal(innerHtml) {
  const root = document.getElementById('modal-root');
  root.innerHTML = `<div class="modal-overlay" id="modalOverlay"><div class="modal-box">${innerHtml}</div></div>`;
  document.getElementById('modalOverlay').addEventListener('click', (e) => {
    if (e.target.id === 'modalOverlay') closeModal();
  });
}
function closeModal() { document.getElementById('modal-root').innerHTML = ''; }
function toast(msg) {
  const el = document.createElement('div');
  el.textContent = msg;
  el.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:var(--ink);color:#fff;padding:10px 18px;border-radius:20px;font-size:13px;z-index:200;box-shadow:0 4px 14px rgba(0,0,0,0.25);';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2200);
}
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/* ---------------- boot ---------------- */
renderAll();
