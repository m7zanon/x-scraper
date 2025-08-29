// main.js
const { PlaywrightCrawler, ProxyConfiguration, log } = require('crawlee');

function parseBool(v, def = true) {
  if (v === undefined) return def;
  return String(v).toLowerCase() !== 'false' && v !== '0';
}

async function setAuthCookies(page) {
  const auth = process.env.X_AUTH_TOKEN;
  const ct0 = process.env.X_CT0;

  if (!auth || !ct0) return;

  const cookies = [
    { name: 'auth_token', value: auth, domain: '.x.com', path: '/', httpOnly: true, secure: true },
    { name: 'ct0', value: ct0, domain: '.x.com', path: '/', httpOnly: true, secure: true },
    // Mantém compatibilidade com twitter.com se necessário:
    { name: 'auth_token', value: auth, domain: '.twitter.com', path: '/', httpOnly: true, secure: true },
    { name: 'ct0', value: ct0, domain: '.twitter.com', path: '/', httpOnly: true, secure: true },
  ];
  await page.context().addCookies(cookies);
}

async function autoScroll(page, { maxScrolls = 10, delayMs = 1200 }) {
  for (let i = 0; i < maxScrolls; i++) {
    await page.mouse.wheel(0, 2000);
    await page.waitForTimeout(delayMs);
  }
}

function extractTweetsFromDom() {
  // roda no browser: pega artigos (tweets) visíveis
  const articles = Array.from(document.querySelectorAll('article[role="article"]'));
  return articles.map(a => {
    const linkEl = a.querySelector('a[href*="/status/"][role="link"]');
    const url = linkEl ? linkEl.href : null;
    const id = url ? (url.split('/status/')[1] || '').split('?')[0] : null;
    const text = a.innerText || '';
    const userEl = a.querySelector('a[href^="https://x.com/"] span');
    const username = userEl ? userEl.textContent : null;
    return { id, url, text, username };
  }).filter(t => t.id && t.url);
}

/**
 * Roda o crawler no targetUrl e retorna um array de tweets.
 * @param {string} targetUrl
 * @param {{maxScrolls?: number, delayMs?: number}} opts
 * @returns {Promise<Array>}
 */
async function runScraper(targetUrl, opts = {}) {
  if (!targetUrl) throw new Error('Missing targetUrl');

  const items = [];
  const headless = parseBool(process.env.HEADLESS, true);

  const crawler = new PlaywrightCrawler({
    launchContext: {
      launchOptions: {
        headless,
        // aumenta estabilidade em VPS com pouco /dev/shm
        args: ['--disable-dev-shm-usage'],
      },
    },
    // Proxy opcional via env HTTP_PROXY
    proxyConfiguration: process.env.HTTP_PROXY
      ? new ProxyConfiguration({ proxyUrls: [process.env.HTTP_PROXY] })
      : undefined,

    // HANDLER VAI NO CONSTRUTOR (Crawlee 3.x):
    requestHandler: async ({ page, request }) => {
      log.info(`▶️ Abrindo: ${request.url}`);

      // garante cookies antes de navegar
      await setAuthCookies(page);

      await page.goto(request.url, { waitUntil: 'domcontentloaded', timeout: 90_000 });

      // rolar feed para carregar mais tweets
      await autoScroll(page, opts);

      // extrair no DOM
      const pageItems = await page.evaluate(extractTweetsFromDom);
      items.push(...pageItems);
      log.info(`✅ Coletados ${pageItems.length} itens nesta página`);
    },
  });

  await crawler.run([targetUrl]);

  // de-duplicar por id
  const uniq = new Map();
  for (const t of items) uniq.set(t.id, t);
  return Array.from(uniq.values());
}

module.exports = { runScraper };