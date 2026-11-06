pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

async function pdfText(bytes) {
  const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
  let out = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    let lastY = null;
    for (const it of content.items) {
      const y = it.transform[5];
      out += (lastY !== null && Math.abs(y - lastY) > 2 ? '\n' : ' ') + it.str;
      lastY = y;
    }
    out += '\n';
  }
  return out;
}

function parseVoucher(text) {
  const t = text.replace(/[ \t\u00a0]+/g, ' ');
  if (!/voucher/i.test(t)) throw new Error('This does not look like a CeX voucher PDF.');
  const no = t.match(/Order No\s*:\s*([A-Z0-9]+)/i);
  const val = t.match(/Value\s*=\s*(\D{0,3}?)\s*([\d.,]+)/i);
  const issue = t.match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/);
  const exp = t.match(/Expiry Date\s*:\s*(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/i);
  const missing = [];
  if (!no) missing.push('order number');
  if (!val) missing.push('value');
  if (!issue) missing.push('issue date/time');
  if (!exp) missing.push('expiry date');
  if (missing.length) throw new Error('Could not find: ' + missing.join(', '));
  const mi = MONTHS.indexOf(exp[2].toLowerCase());
  if (mi < 0) throw new Error('Unrecognised expiry month: ' + exp[2]);

  let amount = val[2];
  amount = /,\d{2}$/.test(amount) ? amount.replace(/\./g, '').replace(',', '.') : amount.replace(/,/g, '');
  if (!(parseFloat(amount) > 0)) throw new Error('Voucher value looks wrong: ' + val[2]);
  const currency = /[£€$]/.test(val[1]) ? val[1].match(/[£€$]/)[0] : '£';
  const p2 = n => String(n).padStart(2, '0');
  return {
    voucherNo: no[1],
    value: amount,
    currency,
    issueDate: `${issue[1]}/${issue[2]}/${issue[3]}`,
    issueTime: `${issue[4]}:${issue[5]}:${issue[6]}`,
    expiryDate: `${p2(exp[1])}/${p2(mi + 1)}/${exp[3]}`
  };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'offscreen-parse') return;
  (async () => {
    try {
      const bin = atob(msg.b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      sendResponse({ ok: true, voucher: parseVoucher(await pdfText(bytes)) });
    } catch (e) {
      sendResponse({ ok: false, error: e.message || String(e) });
    }
  })();
  return true;
});
