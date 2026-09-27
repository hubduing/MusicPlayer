/* Съёмка интерфейса в реальном Chromium: смотрим, как всё выглядит.
   Запуск: node tests/shot.js [базовый URL]  → файлы в tests/shots/ */
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const CHROME = [
  path.join(process.env.LOCALAPPDATA || '', 'ms-playwright', 'chromium-1234', 'chrome-win64', 'chrome.exe'),
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
].find((p) => fs.existsSync(p));

const BASE = process.argv[2] || 'http://127.0.0.1:7620';
const PORT = Number(process.argv[3]) || 9411;
const OUT = path.join(__dirname, 'shots');
const profile = path.join(__dirname, '.chrome-profile');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const chrome = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--headless=new',
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--autoplay-policy=no-user-gesture-required', '--mute-audio', '--window-size=1440,900',
    'about:blank'
  ], { stdio: 'ignore', windowsHide: true });

  let version = null;
  for (let i = 0; i < 60 && !version; i += 1) {
    await sleep(250);
    try {
      version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
    } catch {
      /* ждём */
    }
  }
  if (!version) {
    chrome.kill();
    throw new Error('Chromium не поднялся');
  }

  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  let id = 1;
  const pend = new Map();
  let session = null;
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pend.has(msg.id)) {
      const { resolve, reject } = pend.get(msg.id);
      pend.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mid = id++;
    pend.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params, ...(session ? { sessionId: session } : {}) }));
  });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  session = (await send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
  await send('Runtime.enable');
  await send('Page.enable');

  const shot = async (name) => {
    const img = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(img.data, 'base64'));
    console.log(`  → shots/${name}.png`);
  };

  await send('Page.navigate', { url: BASE });
  await sleep(2500);
  await shot('01-library-ember');

  await evaluate(`(async () => {
    const app = window.__app;
    const list = app.libraryView.visibleTracks();
    await app.player.playTracks(list, 0, { type: 'library', name: 'Библиотека' });
    await new Promise(r => setTimeout(r, 1500));
    app.queue.open();
    return true;
  })()`);
  await sleep(900);
  await shot('02-playing-queue');

  await evaluate('window.__app.queue.close(), window.__app.setView("albums"), true');
  await sleep(900);
  await shot('03-albums');

  await evaluate('window.__app.setView("artists"), true');
  await sleep(700);
  await shot('04-artists');

  await evaluate(`(async () => {
    window.__app.setView('tracks');
    await new Promise(r => setTimeout(r, 300));
    const m = await import('/js/browser.js');
    m.openFolderBrowser(window.__app);
    return true;
  })()`);
  await sleep(1400);
  await shot('05-browser-modal');

  await evaluate(`(async () => {
    document.querySelector('#modal-root .iconbtn')?.click();
    await new Promise(r => setTimeout(r, 300));
    const app = window.__app;
    const mod = await import('/js/editor.js');
    mod.openTagEditor(app, app.tracks.find(t => t.hasCover) || app.tracks[0]);
    return true;
  })()`);
  await sleep(900);
  await shot('06-tag-editor');

  await evaluate(`(async () => {
    document.querySelector('#modal-root .iconbtn')?.click();
    await new Promise(r => setTimeout(r, 300));
    window.__app.applyTheme('paper');
    return true;
  })()`);
  await sleep(900);
  await shot('07-library-paper');

  await evaluate(`(async () => {
    await window.__app.player.play();
    await new Promise(r => setTimeout(r, 800));
    return true;
  })()`);
  await sleep(600);
  await shot('08-paper-playing');

  ws.close();
  chrome.kill();
  fs.rmSync(profile, { recursive: true, force: true });
  console.log('Готово.');
}

main().catch((err) => {
  console.error('Ошибка съёмки:', err.message);
  process.exit(1);
});