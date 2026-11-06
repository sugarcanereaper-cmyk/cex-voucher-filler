# CeX Voucher Filler

Chrome extension that reads CeX voucher PDFs and fills in the "Add new CeX voucher" form at checkout (including the read-only date/time pickers).

## Install
1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** and select this folder (or unzip `cex-voucher-filler.zip` first).
3. Refresh any open CeX tab.

## Use
1. On the CeX checkout page, click the red **CeX Voucher** button (bottom-left), the toolbar icon, or press **Alt+Shift+V**.
2. Drag one or more voucher PDFs anywhere onto the page, click the drop zone to choose files, or paste them with Ctrl+V.
3. Tick the vouchers to use. The panel shows the basket total and how much is left to pay.
4. Click **Fill form**. With several vouchers selected, each one except the last is added automatically so the form is free for the next one.
5. Check the fields and click **Add** on the page (or tick "Click Add automatically").

## Safety checks
- Warns if the PDF is not a voucher, or if a voucher is expired.
- Warns about duplicates (already in the list, or filled/added before). Expired and previously used vouchers are left unticked.
- Stops and tells you if a field could not be filled.

## Notes
- Vouchers and history are stored locally in this browser (`chrome.storage.local`). Nothing is sent anywhere.
- Parsing expects the English CeX UK receipt layout (Order No, Value, Expiry Date). Other CeX country sites are matched (`*.webuy.com`) but untested.
- The calendar is operated by simulated clicks, so a site redesign of the date picker could break filling. The panel then reports which field failed.
