// Service worker: opens the on-page panel and routes PDF parsing to an offscreen
// document (pdf.js needs a DOM/worker environment, which a service worker lacks).

let creating = null;
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  if (!creating) {
    creating = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['WORKERS'],
      justification: 'Parse CeX voucher PDFs with pdf.js'
    }).finally(() => { creating = null; });
  }
  await creating;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'parsePdf') {
    ensureOffscreen()
      .then(() => chrome.runtime.sendMessage({ type: 'offscreen-parse', b64: msg.b64 }))
      .then(sendResponse)
      .catch(e => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true; // async response
  }
});

function togglePanel(tabId) {
  chrome.tabs.sendMessage(tabId, { type: 'toggle-panel' }).catch(() => {
    // No content script here: not a CeX page, or the page needs a refresh.
    chrome.action.setBadgeBackgroundColor({ color: '#bb1313' });
    chrome.action.setBadgeText({ text: '!' });
    setTimeout(() => chrome.action.setBadgeText({ text: '' }), 2500);
  });
}

chrome.action.onClicked.addListener(tab => togglePanel(tab.id));

chrome.commands.onCommand.addListener(async command => {
  if (command !== 'toggle-panel') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) togglePanel(tab.id);
});
