const express = require('express');
const puppeteer = require('puppeteer');
const axios = require('axios');

const UPSTREAM = process.env.UPSTREAM || 'https://mapleranks.com';
const UA =
  process.env.UA ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';
const PORT = Number(process.env.PORT || 3000);
const WAIT_MS = Number(process.env.WAIT_MS || 8000); // wait for CF JS challenge
const DEBUG_PORT = Number(process.env.DEBUG_PORT || 9223);
const EXECUTABLE_PATH = process.env.PUPPETEER_EXECUTABLE_PATH;
const EXTRA_ARGS = (process.env.PUPPETEER_ARGS || '')
  .split(/\s+/)
  .filter(Boolean);

let cfCookie = process.env.CF_COOKIE || '';
let cfUpdatedAt = 0;
let headlessBrowser;
let manualBrowser;
let refreshing = null;
let manualPoll = null;

async function ensureBrowser(headless = true) {
  const commonArgs = [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled',
    '--lang=zh-CN,zh,en',
    ...EXTRA_ARGS,
  ];
  if (headless) {
    if (headlessBrowser?.isConnected?.()) return headlessBrowser;
    headlessBrowser = await puppeteer.launch({
      headless: 'new',
      args: commonArgs,
      executablePath: EXECUTABLE_PATH,
      ignoreDefaultArgs: ['--enable-automation'],
    });
    return headlessBrowser;
  }
  if (manualBrowser?.isConnected?.()) return manualBrowser;
  manualBrowser = await puppeteer.launch({
    headless: false,
    args: [...commonArgs, `--remote-debugging-port=${DEBUG_PORT}`],
    executablePath: EXECUTABLE_PATH,
    ignoreDefaultArgs: ['--enable-automation'],
    defaultViewport: { width: 1280, height: 800 },
  });
  return manualBrowser;
}

function storeCookies(cookies) {
  const cf = cookies.find((c) => c.name === 'cf_clearance');
  if (!cf) return false;
  cfCookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  cfUpdatedAt = Date.now();
  console.log(
    `[cf] updated at ${new Date(cfUpdatedAt).toISOString()} from domain=${
      cf.domain || 'n/a'
    }`
  );
  return true;
}

async function refreshCookie(headless = true, path = '/') {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const url = `${UPSTREAM}${normalizePath(path)}`;
    const browser = await ensureBrowser(headless);
    const page = await newPage(browser);
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(WAIT_MS);
      const cookies = await page.cookies(UPSTREAM);
      if (!storeCookies(cookies)) throw new Error('cf_clearance not found');
    } finally {
      await safeClose(page);
    }
  })();
  try {
    await refreshing;
  } finally {
    refreshing = null;
  }
}

async function pullCookieFrom(browser) {
  if (!browser?.isConnected?.()) return false;
  const pages = await browser.pages();
  for (const p of pages) {
    try {
      const cookies = await p.cookies(UPSTREAM);
      if (storeCookies(cookies)) return true;
    } catch (err) {
      console.warn('[pullCookieFrom] page read failed', err?.message || err);
    }
  }
  // fallback: create a page to read cookies
  const page = await browser.newPage();
  try {
    await page.goto(UPSTREAM, { waitUntil: 'domcontentloaded', timeout: 20000 });
    const cookies = await page.cookies(UPSTREAM);
    return storeCookies(cookies);
  } finally {
    await safeClose(page);
  }
}

function isCFChallenge(body) {
  if (typeof body !== 'string') return false;
  const lower = body.toLowerCase();
  return (
    lower.includes('cloudflare') &&
    (lower.includes('ray id') ||
      lower.includes('checking your browser') ||
      lower.includes('verify you are human') ||
      lower.includes('turnstile'))
  );
}

async function upstreamGet(url) {
  const headers = {
    'user-agent': UA,
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
  };
  if (cfCookie) headers.cookie = cfCookie;
  return axios.get(url, {
    headers,
    responseType: 'text',
    validateStatus: () => true,
    timeout: 60000,
  });
}

function targetPath(req) {
  const p = req.originalUrl.replace(/^\/proxy/, '') || '/';
  return p.startsWith('/') ? p : `/${p}`;
}

function normalizePath(p) {
  if (!p) return '/';
  if (p.startsWith('http')) {
    try {
      const url = new URL(p);
      return url.pathname + (url.search || '');
    } catch {
      return '/';
    }
  }
  return p.startsWith('/') ? p : `/${p}`;
}

function startManualPolling(browser) {
  if (manualPoll) clearInterval(manualPoll);
  manualPoll = setInterval(async () => {
    try {
      const ok = await pullCookieFrom(browser);
      if (ok) {
        console.log('[manual] cf_clearance captured via polling');
        clearInterval(manualPoll);
      }
    } catch (err) {
      console.warn('[manual] poll failed', err?.message || err);
    }
  }, 3000);
  setTimeout(() => manualPoll && clearInterval(manualPoll), 3 * 60 * 1000);
}

async function safeClose(page) {
  try {
    await page.close();
  } catch {
    /* ignore */
  }
}

async function closeBrowsers() {
  try {
    await headlessBrowser?.close();
  } catch {
    /* ignore */
  }
  try {
    await manualBrowser?.close();
  } catch {
    /* ignore */
  }
}

const app = express();

app.get('/status', (_req, res) => {
  res.json({
    hasCookie: Boolean(cfCookie),
    updatedAt: cfUpdatedAt || null,
  });
});

app.get('/manual/refresh', async (_req, res) => {
  try {
    const browser = await ensureBrowser(false);
    startManualPolling(browser);
    const page = await newPage(browser);
    await page.goto(`${UPSTREAM}${normalizePath(_req.query?.path)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    res.json({
      wsEndpoint: browser.wsEndpoint(),
      tip: `ssh -L ${DEBUG_PORT}:127.0.0.1:${DEBUG_PORT} server && chrome://inspect -> configure -> localhost:${DEBUG_PORT}`,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// 手动拉取当前浏览器里的 cookie（如果轮询还没抓到，调用这个）
app.get('/manual/pull', async (_req, res) => {
  try {
    const ok = await pullCookieFrom(manualBrowser);
    res.json({
      success: ok,
      hasCookie: Boolean(cfCookie),
      updatedAt: cfUpdatedAt || null,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get('/proxy/*', async (req, res) => {
  const path = targetPath(req);
  const url = `${UPSTREAM}${path}`;
  try {
    const first = await upstreamGet(url);
    if (first.status === 403 || isCFChallenge(first.data)) {
      try {
        await refreshCookie(true, path);
      } catch (err) {
        console.warn('[auto] refresh failed', err?.message || err);
      }
      const retry = await upstreamGet(url);
      res.status(retry.status).send(retry.data);
      return;
    }
    res.status(first.status).send(first.data);
  } catch (err) {
    res.status(500).send('proxy error');
  }
});

app.listen(PORT, () => {
  console.log(`proxy listening on :${PORT}`);
  console.log(`upstream: ${UPSTREAM}`);
});

process.on('SIGINT', async () => {
  await closeBrowsers();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  await closeBrowsers();
  process.exit(0);
});

async function newPage(browser) {
  const page = await browser.newPage();
  await setupPage(page);
  return page;
}

async function setupPage(page) {
  await page.setUserAgent(UA);
  await page.setViewport({ width: 1280, height: 800 });
  await page.setExtraHTTPHeaders({
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
  });
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };
    Object.defineProperty(navigator, 'languages', {
      get: () => ['zh-CN', 'zh', 'en'],
    });
    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4, 5],
    });
    const originalQuery = window.navigator.permissions?.query;
    if (originalQuery) {
      window.navigator.permissions.query = (parameters) =>
        parameters && parameters.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : originalQuery(parameters);
    }
  });
}
