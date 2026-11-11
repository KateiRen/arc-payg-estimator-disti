'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const browser = process.env.ARC_PRINT_BROWSER;

test('printing includes only the required sheets, fits each page, and preserves the browser UI', {
  skip: !browser || typeof WebSocket === 'undefined'
    ? 'Set ARC_PRINT_BROWSER to a Chromium browser executable and use Node.js 22+ for print integration tests'
    : false,
  timeout: 60000,
}, async t => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-print-test-'));
  const child = spawn(browser, [
    '--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let socket;
  t.after(async () => {
    socket?.close();
    if (child.pid && child.exitCode === null) {
      child.kill();
      await once(child, 'exit');
    }
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  const endpoint = await new Promise((resolve, reject) => {
    let output = '';
    child.on('error', reject);
    child.stderr.on('data', data => {
      output += data;
      const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(output);
      if (match) resolve(match[1]);
    });
    child.on('exit', code => reject(new Error(`Browser exited before becoming ready (${code}): ${output}`)));
  });
  socket = new WebSocket(endpoint);
  await once(socket, 'open');
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params, sessionId }));
  });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const command = (method, params) => send(method, params, sessionId);
  const evaluate = async expression => {
    const result = await command('Runtime.evaluate', { expression, returnByValue: true });
    assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await command('Page.enable');
  await command('Page.navigate', { url: pathToFileURL(path.resolve(__dirname, '..', 'site', 'index.html')).href });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await evaluate("typeof preparePrintReport === 'function' && document.readyState === 'complete'")) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(await evaluate("typeof preparePrintReport"), 'function');
  await evaluate("let stableStyle=document.createElement('style');stableStyle.textContent='*{caret-color:transparent!important;transition:none!important;animation:none!important}';document.head.append(stableStyle)");
  const screenState = `JSON.stringify({html:document.querySelector('.shell').outerHTML,focus:document.activeElement.outerHTML,x:scrollX,y:scrollY,state,storage:{...localStorage},
    layout:[...document.querySelectorAll('.shell *')].map(e=>{let r=e.getBoundingClientRect(),s=getComputedStyle(e);return[r.x,r.y,r.width,r.height,s.display,s.fontSize,s.color,s.backgroundColor]})})`;

  for (const width of [1280, 480]) {
    await command('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    for (const activePane of ['instructions', 'sql', 'windows', 'pricing']) {
      for (const windowsCount of [0, 3]) {
        await evaluate(`pane=${JSON.stringify(activePane)};state.windows.rows[0].qty=${windowsCount};render();document.querySelector('.tab[data-pane="'+pane+'"]').focus();
          if(pane==='pricing')$('currency').focus();
          if(pane==='sql'||pane==='windows'){$('workloads').querySelector('input').focus();document.querySelector('details').open=true}`);
        const before = await evaluate(screenState);
        const report = await evaluate(`preparePrintReport();
          ({titles:[...document.querySelectorAll('.print-content>h2')].map(e=>e.textContent),
            fits:[...document.querySelectorAll('.print-sheet')].every(sheet=>{
              let content=sheet.firstElementChild,scale=Number(content.style.transform.slice(6,-1));
              return content.scrollHeight*scale<=sheet.clientHeight+.1&&content.scrollWidth*scale<=sheet.clientWidth+.1}),
            privateData:!!document.querySelector('.print-report #pricingPane')||document.querySelector('.print-report').textContent.includes('Distributor business case'),
            details:[...document.querySelectorAll('.print-report details')].every(e=>e.open),
            controls:document.querySelectorAll('.print-report input,.print-report select,.print-report button').length})`);
        assert.deepEqual(report.titles, windowsCount
          ? ['Instructions', 'SQL Server PAYG - EUR', 'Windows Server PAYG - EUR']
          : ['Instructions', 'SQL Server PAYG - EUR']);
        assert.equal(report.fits, true);
        assert.equal(report.privateData, false);
        assert.equal(report.details, true);
        assert.equal(report.controls, 0);
        await evaluate('clearPrintReport()');
        const after = await evaluate(screenState);
        assert.ok(after === before, `Screen, focus, and data unchanged: ${activePane}, ${width}px, ${windowsCount} VMs`);
        const pdf = await command('Page.printToPDF', { preferCSSPageSize: true, printBackground: true });
        const pages = Buffer.from(pdf.data, 'base64').toString('latin1').match(/\/Type\s*\/Page\b/g) || [];
        assert.equal(pages.length, windowsCount ? 3 : 2, `${activePane}, ${width}px, ${windowsCount} VMs`);
        assert.equal(await evaluate("!!document.querySelector('.print-report')"), false);
        assert.ok(await evaluate(screenState) === before, 'Native printing also preserves the screen and data');
      }
    }
  }
  await evaluate("state.sql.rows=Array.from({length:100},()=>({edition:'Enterprise',qty:1,cores:64,uptime:'7x24'}));render()");
  assert.equal(await evaluate(`preparePrintReport();
    document.querySelectorAll('.print-report .sql-work tbody tr').length===100&&
    [...document.querySelectorAll('.print-sheet')].every(sheet=>{
      let content=sheet.firstElementChild,scale=Number(content.style.transform.slice(6,-1));
      return content.scrollHeight*scale<=sheet.clientHeight+.1&&content.scrollWidth*scale<=sheet.clientWidth+.1})`), true);
  await evaluate('clearPrintReport()');
  const pdf = await command('Page.printToPDF', { preferCSSPageSize: true });
  assert.equal((Buffer.from(pdf.data, 'base64').toString('latin1').match(/\/Type\s*\/Page\b/g) || []).length, 3);
});
