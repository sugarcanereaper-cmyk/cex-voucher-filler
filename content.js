(() => {
  if (window.__cexVoucherFiller) return;
  window.__cexVoucherFiller = true;

  // ---------------------------------------------------------------- helpers
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const waitFor = async (fn, ms = 1500) => {
    const t = Date.now();
    while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(40); }
    return null;
  };
  const txt = el => (el.textContent || '').trim();
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (n, cur = '£') => cur + n.toFixed(2);
  const parseDMY = s => { const [d, m, y] = s.split('/').map(Number); return { d, m, y }; };
  const isExpired = v => { const { d, m, y } = parseDMY(v.expiryDate); return new Date(y, m - 1, d, 23, 59, 59) < new Date(); };
  const fmtWhen = iso => new Date(iso).toLocaleString();

  // ---------------------------------------------------------------- state
  const state = {
    vouchers: [],            // {voucherNo,value,currency,issueDate,issueTime,expiryDate,fileName,selected}
    settings: { autoAdd: false },
    history: {},             // voucherNo -> {at, action: 'added' | 'rejected' | 'filled', reason?}
    open: false,
    busy: false,
    log: []
  };

  async function load() {
    const r = await chrome.storage.local.get({ cexVouchers: [], cexSettings: { autoAdd: false }, cexHistory: {} });
    state.vouchers = r.cexVouchers;
    state.settings = Object.assign({ autoAdd: false }, r.cexSettings);
    state.history = r.cexHistory;
  }
  const save = () => chrome.storage.local.set({
    cexVouchers: state.vouchers, cexSettings: state.settings, cexHistory: state.history
  });

  // ---------------------------------------------------------------- page detection
  function readBasketTotal() {
    const t = document.body.innerText || '';
    const all = [...t.matchAll(/(?:^|\n)\s*Total\s*\n?\s*[£€$]?\s*([\d,]+[.,]\d{2})/gi)];
    if (!all.length) return null;
    const raw = all[all.length - 1][1];
    return parseFloat(/,\d{2}$/.test(raw) ? raw.replace(/\./g, '').replace(',', '.') : raw.replace(/,/g, ''));
  }

  function getAppliedVouchersOnPage() {
    const applied = new Set();
    const box = document.querySelector('.checkout-voucher') || document.body;
    const t = box.innerText || '';
    for (const v of state.vouchers) {
      if (t.includes(v.voucherNo)) applied.add(v.voucherNo);
    }
    return applied;
  }

  // ---------------------------------------------------------------- page: form filling
  const click = el => {
    for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
    }
  };
  const MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const menu = () => [...document.querySelectorAll('.dp__menu')].find(m => m.getClientRects().length);
  const overlay = () => [...document.querySelectorAll('.dp__overlay')].find(o => o.getClientRects().length);
  const cells = () => [...document.querySelectorAll('.dp__overlay_cell')].filter(c => c.getClientRects().length);

  const closeMenu = async () => {
    const sel = document.querySelector('.dp__action_select');
    if (menu() && sel && sel.getClientRects().length) { click(sel); await sleep(150); }
    if (menu()) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(150);
    }
    if (menu()) { document.body.click(); await sleep(150); }
  };

  const openPicker = async root => {
    if (menu()) await closeMenu();
    click(root.querySelector('input'));
    return waitFor(menu);
  };

  const pickFromOverlay = async (matchFn, dirFn) => {
    for (let i = 0; i < 160; i++) {
      const all = cells();
      const hit = all.find(matchFn);
      if (hit) { click(hit); await sleep(120); return true; }
      if (!dirFn) return false;
      const dir = dirFn(all);
      const ov = overlay() || document;
      const btns = [...ov.querySelectorAll('[aria-label], .dp--arrow-btn-nav, .dp__inner_nav')]
        .filter(b => b.getClientRects().length);
      const re = dir > 0 ? /next|forward|increase|later|up/i : /prev|back|decrease|earlier|down/i;
      let btn = btns.find(b => re.test(b.getAttribute('aria-label') || ''));
      if (!btn) {
        const arrows = btns.filter(b => /arrow|inner_nav/.test(b.className));
        btn = dir > 0 ? arrows[arrows.length - 1] : arrows[0];
      }
      if (!btn) return false;
      click(btn);
      await sleep(60);
    }
    return false;
  };

  const pickDate = async (root, val) => {
    const { d: dd, m: mm, y: yyyy } = parseDMY(val);
    const m = await openPicker(root);
    if (!m) throw new Error('calendar did not open');
    const sels = () => [...m.querySelectorAll('.dp__month_year_select')];
    if (txt(sels()[1]) !== String(yyyy)) {
      click(sels()[1]);
      await waitFor(overlay);
      const ok = await pickFromOverlay(
        c => txt(c) === String(yyyy),
        all => {
          const ys = all.map(c => parseInt(txt(c), 10)).filter(Number.isFinite);
          return yyyy > Math.max(...ys) ? 1 : -1;
        });
      if (!ok) throw new Error('could not select year ' + yyyy);
    }
    if (txt(sels()[0]).toLowerCase().slice(0, 3) !== MON[mm - 1]) {
      click(sels()[0]);
      await waitFor(overlay);
      let ok = await pickFromOverlay(c => txt(c).toLowerCase().startsWith(MON[mm - 1]));
      if (!ok && cells().length === 12) { click(cells()[mm - 1]); await sleep(120); ok = true; }
      if (!ok) throw new Error('could not select month');
    }
    await sleep(100);
    const day = [...m.querySelectorAll('.dp__calendar_item .dp__cell_inner')]
      .find(c => !c.classList.contains('dp__cell_offset') && txt(c) === String(dd));
    if (!day) throw new Error('day not found');
    if (day.classList.contains('dp__cell_disabled')) throw new Error('day is disabled in the calendar');
    click(day);
    await sleep(200);
    await closeMenu();
  };

  const pickTime = async (root, val) => {
    const parts = val.split(':').map(Number);
    const m = await openPicker(root);
    if (!m) throw new Error('time picker did not open');
    for (let i = 0; i < 3; i++) {
      const displays = [...m.querySelectorAll('.dp__time_display')];
      if (!displays[i]) throw new Error('time column ' + i + ' not found');
      click(displays[i]);
      await waitFor(overlay);
      const ok = await pickFromOverlay(c => parseInt(txt(c), 10) === parts[i]);
      if (!ok) throw new Error('could not select time value ' + parts[i]);
      await sleep(100);
    }
    await closeMenu();
  };

  const getForm = () => document.querySelector('#addVoucherForm');

  async function ensureForm() {
    if (getForm()) return getForm();
    const opener = document.querySelector('[data-at="btnAddNewVoucher"] a') ||
      document.querySelector('[data-at="btnAddNewVoucher"]');
    if (!opener) return null;
    click(opener);
    return waitFor(getForm, 2500);
  }

  const setText = (form, name, val) => {
    const el = form.querySelector(`input[name="${name}"]`);
    if (!el) throw new Error(`${name} field not found`);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };

  async function fillOne(v) {
    const problems = [];
    const form = await ensureForm();
    if (!form) return ['Voucher form not found. Go to the checkout step with "Your CeX voucher".'];
    try {
      setText(form, 'voucherNo', v.voucherNo);
      setText(form, 'voucherValue', v.value);
    } catch (e) { return [e.message]; }

    for (const [name, kind, val] of [
      ['issueDate', 'date', v.issueDate],
      ['issueTime', 'time', v.issueTime],
      ['expiryDate', 'date', v.expiryDate]
    ]) {
      const root = form.querySelector(`[data-datepicker-instance][name="${name}"]`);
      if (!root) { problems.push(`${name}: picker not found`); continue; }
      try {
        if (kind === 'date') await pickDate(root, val); else await pickTime(root, val);
        if (!root.querySelector('input').value) problems.push(`${name}: not accepted, enter ${val} manually`);
      } catch (e) {
        problems.push(`${name}: ${e.message}, enter ${val} manually`);
        await closeMenu();
      }
    }
    return problems;
  }

  // Clicks "Add" and waits for CeX to accept or report an error.
  async function submitForm(v) {
    const form = getForm();
    if (!form) return { ok: false, reason: 'form disappeared' };
    const btn = [...form.querySelectorAll('button')].find(b => /^add$/i.test(txt(b)));
    if (!btn) return { ok: false, reason: 'Add button not found' };

    const errRe = /sorry|already used|invalid|not valid|expired|unable|error|try again|not found/i;
    const findError = () => {
      const els = [...document.querySelectorAll('[role="alert"], [class*="snackbar"], [class*="toast"], [class*="alert"], [class*="announcement"]')];
      for (const el of els) {
        if (host.contains(el)) continue;
        if (el.getClientRects().length === 0) continue;
        const t = txt(el);
        if (t && t.length < 300 && errRe.test(t)) return t;
      }
      return null;
    };

    const beforeErr = findError();
    const countBefore = getAppliedVouchersOnPage().size;
    btn.click();

    const outcome = await waitFor(() => {
      const applied = getAppliedVouchersOnPage();
      if (applied.has(v.voucherNo)) return { ok: true };
      if (applied.size > countBefore) return { ok: true };

      const err = findError();
      if (err && err !== beforeErr) return { ok: false, reason: err };

      return null;
    }, 7000);

    if (outcome) return outcome;

    if (getAppliedVouchersOnPage().has(v.voucherNo)) return { ok: true };
    const lastErr = findError();
    if (lastErr) return { ok: false, reason: lastErr };

    return { ok: false, reason: 'CeX did not confirm adding this voucher' };
  }

  // ---------------------------------------------------------------- PDF import
  const toB64 = file => new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1]);
    r.onerror = () => rej(new Error('could not read file'));
    r.readAsDataURL(file);
  });

  async function importFiles(files) {
    for (const f of files) {
      if (!/\.pdf$/i.test(f.name) && f.type !== 'application/pdf') { addLog(`${f.name}: not a PDF`, 'err'); continue; }
      try {
        const res = await chrome.runtime.sendMessage({ type: 'parsePdf', b64: await toB64(f) });
        if (!res || !res.ok) throw new Error((res && res.error) || 'no response from the extension (refresh the page and retry)');
        addVoucher(Object.assign(res.voucher, { fileName: f.name }));
      } catch (e) {
        addLog(`${f.name}: ${e.message}`, 'err');
      }
    }
    await save();
    render();
  }

  function addVoucher(v) {
    if (state.vouchers.some(x => x.voucherNo === v.voucherNo)) {
      addLog(`${v.voucherNo} is already in the list`, 'warn');
      return;
    }
    const expired = isExpired(v);
    const applied = getAppliedVouchersOnPage().has(v.voucherNo);
    const h = state.history[v.voucherNo];
    v.selected = !expired && !applied && (!h || h.action !== 'rejected');
    state.vouchers.push(v);
    addLog(`Imported ${v.voucherNo} (${money(parseFloat(v.value), v.currency)})`, 'ok');
    if (expired) addLog(`${v.voucherNo} has expired`, 'warn');
  }

  // ---------------------------------------------------------------- fill orchestration
  async function fillSelected() {
    if (state.busy) return;
    const list = state.vouchers.filter(v => v.selected);
    if (!list.length) { addLog('Select at least one voucher', 'warn'); render(); return; }
    state.busy = true;
    render();
    try {
      for (let i = 0; i < list.length; i++) {
        const v = list[i];
        const last = i === list.length - 1;
        addLog(`Filling ${v.voucherNo}...`);
        const problems = await fillOne(v);
        if (problems.length) {
          problems.forEach(p => addLog(`${v.voucherNo}: ${p}`, 'err'));
          addLog('Stopped. Fix the fields above, then click Add yourself.', 'err');
          break;
        }

        if (state.settings.autoAdd || !last) {
          const r = await submitForm(v);
          if (!r.ok) {
            if (/already used/i.test(r.reason)) {
              state.history[v.voucherNo] = { at: new Date().toISOString(), action: 'rejected', reason: 'Already used' };
            } else {
              state.history[v.voucherNo] = { at: new Date().toISOString(), action: 'rejected', reason: r.reason };
            }
            v.selected = false;
            addLog(`${v.voucherNo}: ${r.reason}`, 'err');
            await save();
            render();
            // Allow the loop to continue to try any remaining selected vouchers
            await sleep(1000);
            continue;
          }
          state.history[v.voucherNo] = { at: new Date().toISOString(), action: 'added' };
          v.selected = false;
          addLog(`${v.voucherNo} added successfully`, 'ok');
          await sleep(1200);
        } else {
          state.history[v.voucherNo] = { at: new Date().toISOString(), action: 'filled' };
          addLog(`${v.voucherNo} filled. Check it, then click Add on the page.`, 'ok');
        }
        await save();
        render();
      }
    } catch (e) {
      addLog('Unexpected error: ' + e.message, 'err');
    }
    state.busy = false;
    await save();
    render();
  }

  // ---------------------------------------------------------------- UI (shadow DOM)
  const host = document.createElement('div');
  host.id = 'cex-voucher-filler-root';
  host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;left:0;top:0;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; font-family: Poppins, 'Segoe UI', Arial, sans-serif; }
      .fab { position: fixed; left: 20px; bottom: 20px; background: #e20a03; color: #fff; border: 0;
        border-radius: 24px; padding: 10px 16px; font-size: 14px; font-weight: 600; cursor: pointer;
        box-shadow: 0 2px 10px rgba(0,0,0,.3); }
      .fab:hover { background: #b50802; }
      .panel { position: fixed; left: 20px; bottom: 70px; width: 370px; max-height: 82vh; overflow: auto;
        background: #fff; color: #0d0d0d; border-radius: 14px; box-shadow: 0 6px 30px rgba(0,0,0,.35);
        padding: 14px; font-size: 13px; display: none; }
      .panel.open { display: block; }
      .head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
      .head h3 { margin: 0; font-size: 15px; }
      .x { background: none; border: 0; font-size: 20px; cursor: pointer; color: #666; line-height: 1; }
      .drop { border: 2px dashed #ccc; border-radius: 12px; padding: 14px 10px; text-align: center;
        color: #666; cursor: pointer; margin-bottom: 8px; }
      .drop:hover, .drop.over { border-color: #e20a03; background: #fee3e1; color: #7e0602; }
      .toolbar { display: flex; justify-content: space-between; align-items: center; font-size: 11px; margin-bottom: 6px; }
      .toolbar a { color: #e20a03; text-decoration: underline; cursor: pointer; margin-right: 8px; }
      .toolbar a:hover { color: #b50802; }
      .row { display: flex; gap: 8px; align-items: flex-start; padding: 7px 6px; border-bottom: 1px solid #eee; }
      .row .info { flex: 1; min-width: 0; }
      .row .no { font-weight: 600; word-break: break-all; }
      .row .meta { color: #666; font-size: 11px; }
      .row .val { font-weight: 600; white-space: nowrap; }
      .chip { display: inline-block; font-size: 10px; border-radius: 8px; padding: 1px 6px; margin-left: 4px; font-weight: 600; cursor: pointer; }
      .chip.bad { background: #ffcdcd; color: #6d0400; }
      .chip.warn { background: #fef7cd; color: #8a6b00; }
      .chip.good { background: #ebffe7; color: #187700; }
      .rm { background: none; border: 0; color: #999; cursor: pointer; font-size: 16px; line-height: 1; }
      .rm:hover { color: #bb1313; }
      .empty { color: #999; text-align: center; padding: 10px 0; }
      .sum { background: #f2f2f2; border-radius: 10px; padding: 8px 10px; margin: 10px 0; line-height: 1.6; }
      .sum b { float: right; }
      .sum .left { font-weight: 700; border-top: 1px solid #ddd; margin-top: 4px; padding-top: 4px; }
      .opt { display: flex; gap: 6px; align-items: center; margin: 8px 0; }
      .btns { display: flex; gap: 8px; }
      .btn { border: 0; border-radius: 18px; padding: 8px 14px; font-weight: 600; cursor: pointer; font-size: 13px; }
      .primary { background: #e20a03; color: #fff; flex: 1; }
      .primary:disabled { background: #ccc; cursor: default; }
      .ghost { background: #fff; border: 1px solid #333; color: #333; }
      .log { margin-top: 10px; font-size: 11px; max-height: 120px; overflow: auto; white-space: pre-wrap; }
      .log div.err { color: #bb1313; } .log div.ok { color: #187700; } .log div.warn { color: #8a6b00; }
      .hint { color: #999; font-size: 10px; margin-top: 8px; }
      .dropall { position: fixed; inset: 0; background: rgba(226,10,3,.12); border: 4px dashed #e20a03;
        display: none; align-items: center; justify-content: center; font-size: 22px; font-weight: 700;
        color: #7e0602; pointer-events: none; }
      .dropall.on { display: flex; }
    </style>
    <div class="dropall" id="dropall">Drop voucher PDF(s) to import</div>
    <button class="fab" id="fab">CeX Voucher</button>
    <div class="panel" id="panel">
      <div class="head"><h3>CeX Voucher Filler</h3><button class="x" data-act="close" title="Close">&times;</button></div>
      <div class="drop" id="drop">Drop voucher PDFs here, click to choose, or paste (Ctrl+V)</div>
      <input type="file" id="file" accept="application/pdf,.pdf" multiple hidden>
      <div class="toolbar">
        <div>
          <a data-act="select-unused">Select unused</a>
          <a data-act="unselect-all">Deselect all</a>
        </div>
        <div>
          <a data-act="clear-history" title="Clear all 'Already added' / 'Already used' status flags">Reset status flags</a>
        </div>
      </div>
      <div id="list"></div>
      <div class="sum" id="sum"></div>
      <label class="opt"><input type="checkbox" id="auto"> Click <b>Add</b> automatically after filling</label>
      <div class="btns">
        <button class="btn primary" id="fill" data-act="fill">Fill form</button>
        <button class="btn ghost" data-act="clear">Clear list</button>
      </div>
      <div class="log" id="log"></div>
      <div class="hint">Click any badge to toggle/clear its status. Vouchers stored locally.</div>
    </div>`;
  document.documentElement.appendChild(host);

  const $ = id => root.getElementById(id);

  function addLog(msg, cls = '') {
    state.log.push({ msg, cls });
    if (state.log.length > 30) state.log.shift();
    renderLog();
  }
  function renderLog() {
    $('log').innerHTML = state.log.map(l => `<div class="${l.cls}">${esc(l.msg)}</div>`).join('');
    $('log').scrollTop = 1e9;
  }

  function renderList() {
    if (!state.vouchers.length) { $('list').innerHTML = '<div class="empty">No vouchers yet</div>'; return; }
    const appliedOnPage = getAppliedVouchersOnPage();

    $('list').innerHTML = state.vouchers.map((v, i) => {
      const chips = [];
      if (isExpired(v)) {
        chips.push('<span class="chip bad">Expired</span>');
      }

      if (appliedOnPage.has(v.voucherNo)) {
        chips.push(`<span class="chip good" data-act="toggle-chip" data-i="${i}" title="Applied to this order">Applied to order</span>`);
      } else {
        const h = state.history[v.voucherNo];
        if (h) {
          if (h.action === 'rejected') {
            chips.push(`<span class="chip bad" data-act="toggle-chip" data-i="${i}" title="${esc(h.reason || 'Rejected')} (click to clear)">Already used</span>`);
          } else if (h.action === 'added') {
            chips.push(`<span class="chip warn" data-act="toggle-chip" data-i="${i}" title="Marked as added on ${esc(fmtWhen(h.at))} (click to retry)">Used before</span>`);
          } else if (h.action === 'filled') {
            chips.push(`<span class="chip warn" data-act="toggle-chip" data-i="${i}" title="Filled on ${esc(fmtWhen(h.at))} (click to clear)">Filled before</span>`);
          }
        }
      }

      return `<div class="row">
        <input type="checkbox" data-i="${i}" ${v.selected ? 'checked' : ''}>
        <div class="info"><div class="no">${esc(v.voucherNo)}${chips.join('')}</div>
          <div class="meta">Issued ${esc(v.issueDate)} ${esc(v.issueTime)} &middot; expires ${esc(v.expiryDate)}</div></div>
        <div class="val">${esc(money(parseFloat(v.value), v.currency))}</div>
        <button class="rm" data-act="remove" data-i="${i}" title="Remove">&times;</button></div>`;
    }).join('');
  }

  function renderSummary() {
    const sel = state.vouchers.filter(v => v.selected);
    const cur = (sel[0] || state.vouchers[0] || {}).currency || '£';
    const selTotal = sel.reduce((a, v) => a + parseFloat(v.value), 0);
    const basket = readBasketTotal();
    let html = `<div>Selected vouchers (${sel.length}) <b>${money(selTotal, cur)}</b></div>`;
    if (basket === null) {
      html += '<div style="color:#666">Basket total not found on this page</div>';
    } else {
      html += `<div>Total shown on page <b>${money(basket, cur)}</b></div>`;
      const left = basket - selTotal;
      html += left >= 0
        ? `<div class="left">Left to pay <b>${money(left, cur)}</b></div>`
        : `<div class="left">Vouchers exceed total by <b>${money(-left, cur)}</b></div>`;
    }
    $('sum').innerHTML = html;
  }

  function render() {
    renderList();
    renderSummary();
    $('auto').checked = !!state.settings.autoAdd;
    $('fill').disabled = state.busy;
    $('fill').textContent = state.busy ? 'Working...' : 'Fill form';
    renderLog();
  }

  let timer = null;
  function setOpen(open) {
    state.open = open;
    $('panel').classList.toggle('open', open);
    clearInterval(timer);
    if (open) { render(); timer = setInterval(renderSummary, 1500); }
  }

  $('fab').addEventListener('click', () => setOpen(!state.open));
  $('drop').addEventListener('click', () => $('file').click());
  $('file').addEventListener('change', e => { importFiles([...e.target.files]); e.target.value = ''; });
  $('auto').addEventListener('change', e => { state.settings.autoAdd = e.target.checked; save(); });
  $('drop').addEventListener('dragover', e => { e.preventDefault(); $('drop').classList.add('over'); });
  $('drop').addEventListener('dragleave', () => $('drop').classList.remove('over'));
  $('drop').addEventListener('drop', () => $('drop').classList.remove('over'));

  root.addEventListener('click', async e => {
    const t = e.target.closest('[data-act]');
    if (!t) return;
    const act = t.dataset.act, i = Number(t.dataset.i);
    if (act === 'close') setOpen(false);
    else if (act === 'fill') fillSelected();
    else if (act === 'remove') { state.vouchers.splice(i, 1); await save(); render(); }
    else if (act === 'toggle-chip') {
      const v = state.vouchers[i];
      if (v) {
        if (state.history[v.voucherNo]) {
          delete state.history[v.voucherNo];
          v.selected = true;
          addLog(`Reset status for ${v.voucherNo}`);
        } else {
          state.history[v.voucherNo] = { at: new Date().toISOString(), action: 'rejected', reason: 'Marked manually' };
          v.selected = false;
        }
        await save();
        render();
      }
    }
    else if (act === 'select-unused') {
      const applied = getAppliedVouchersOnPage();
      state.vouchers.forEach(v => {
        const exp = isExpired(v);
        const app = applied.has(v.voucherNo);
        const rej = state.history[v.voucherNo] && state.history[v.voucherNo].action === 'rejected';
        v.selected = !exp && !app && !rej;
      });
      await save();
      render();
    }
    else if (act === 'unselect-all') {
      state.vouchers.forEach(v => { v.selected = false; });
      await save();
      render();
    }
    else if (act === 'clear-history') {
      state.history = {};
      const applied = getAppliedVouchersOnPage();
      state.vouchers.forEach(v => {
        v.selected = !isExpired(v) && !applied.has(v.voucherNo);
      });
      await save();
      addLog('All status flags reset', 'ok');
      render();
    }
    else if (act === 'clear') {
      if (!state.vouchers.length) return;
      if (confirm('Remove all saved vouchers from the list?')) {
        state.vouchers = []; await save(); render();
      }
    }
  });

  root.addEventListener('change', async e => {
    if (e.target.dataset && e.target.dataset.i !== undefined && e.target.type === 'checkbox') {
      state.vouchers[Number(e.target.dataset.i)].selected = e.target.checked;
      await save();
      renderSummary();
    }
  });

  // Page-wide drag & drop and paste
  const hasFiles = e => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
  let dragDepth = 0;
  window.addEventListener('dragenter', e => { if (hasFiles(e)) { dragDepth++; $('dropall').classList.add('on'); } }, true);
  window.addEventListener('dragleave', e => {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) $('dropall').classList.remove('on');
  }, true);
  window.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); }, true);
  window.addEventListener('drop', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    $('dropall').classList.remove('on');
    setOpen(true);
    importFiles([...e.dataTransfer.files]);
  }, true);
  window.addEventListener('paste', e => {
    if (!state.open || !e.clipboardData) return;
    const files = [...e.clipboardData.files].filter(f => /pdf/i.test(f.type) || /\.pdf$/i.test(f.name));
    if (files.length) { e.preventDefault(); importFiles(files); }
  }, true);

  chrome.runtime.onMessage.addListener(msg => {
    if (msg && msg.type === 'toggle-panel') setOpen(!state.open);
  });

  load().then(render);
})();
