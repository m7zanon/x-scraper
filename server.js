// server.js (CommonJS)
const express = require('express');
const { chromium } = require('playwright');

const app = express();
const PORT = process.env.PORT || 3000;

/* ---------- helpers ---------- */

// força render carregando mais <article>
async function autoScroll(page, { steps = 6, delay = 600 } = {}) {
  for (let i = 0; i < steps; i++) {
    await page.evaluate(() => window.scrollBy(0, Math.floor(window.innerHeight * 0.9)));
    await page.waitForTimeout(delay);
  }
}

// remove “contadores” no fim do texto (ex.: " ... 1 23 4.5K")
function stripCountersAtEnd(text) {
  if (!text) return text;
  return text.replace(/\s*(\d+(?:[.,]\d+)?[kKmM]?\s*)+$/u, '').trim();
}

/* ---------- rotas básicas ---------- */

app.get('/', (_req, res) => res.type('text/plain').send('X-Scraper API is running 🚀'));
app.get('/healthz', (_req, res) => res.type('text/plain').send('ok'));

/* ---------- /scrape ---------- */

app.get('/scrape', async (req, res) => {
  const rawUrl = (req.query.url || '').toString();
  if (!rawUrl) return res.status(400).json({ error: 'Missing ?url=' });

  // listas → usar site mobile (e lang=en para estabilizar layout)
  const isList = /\/i\/lists\//i.test(rawUrl);
  let navUrl = rawUrl;
  if (isList) {
    navUrl = rawUrl
      .replace(/^https?:\/\/x\.com/i, 'https://mobile.twitter.com')
      .replace(/^https?:\/\/twitter\.com/i, 'https://mobile.twitter.com');
    if (!/\?/.test(navUrl)) navUrl += '?lang=en';
  }

  // parâmetros
  const limit           = parseInt((req.query.limit || '30').toString(), 10);
  const withUser        = ['1','true'].includes((req.query.withUser || '').toString());
  const includeCounters = ['1','true'].includes((req.query.includeCounters || '').toString());
  const headless        = !(['0','false'].includes((req.query.headless || process.env.HEADLESS || '1').toString()));
  const timeoutMs       = parseInt((req.query.timeout || '30000').toString(), 10);
  const debug           = ['1','true'].includes((req.query.debug || '').toString());

  // usar cookies? (default 1; query pode forçar)
  const useCookiesRequested = !['0','false'].includes(
    (req.query.useCookies || process.env.USE_COOKIES || '1').toString()
  );

  let browser;
  try {
    browser = await chromium.launch({
      headless,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    // cria um contexto (com/sem cookies)
    const makeContext = async (withCookies) => {
      const isMobile = isList;
      const userAgent = isMobile
        ? (process.env.USER_AGENT_MOBILE ||
          'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1')
        : (process.env.USER_AGENT ||
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36');

      const ctx = await browser.newContext({
        userAgent,
        viewport: isMobile ? { width: 390, height: 844 } : { width: 1280, height: 900 },
        deviceScaleFactor: isMobile ? 3 : 1,
        extraHTTPHeaders: { 'accept-language': 'en-US,en;q=0.9' },
      });

      // cookies do X (se presentes)
      if (withCookies && process.env.X_AUTH_TOKEN && process.env.X_CT0) {
        await ctx.addCookies([
          // x.com e twitter.com (cobrem web normal)
          { name: 'auth_token', value: process.env.X_AUTH_TOKEN, domain: '.x.com',       path: '/', httpOnly: true, secure: true },
          { name: 'ct0',        value: process.env.X_CT0,        domain: '.x.com',       path: '/', httpOnly: true, secure: true },
          { name: 'auth_token', value: process.env.X_AUTH_TOKEN, domain: '.twitter.com', path: '/', httpOnly: true, secure: true },
          { name: 'ct0',        value: process.env.X_CT0,        domain: '.twitter.com', path: '/', httpOnly: true, secure: true },
          // mobile.twitter.com (listas)
          { name: 'auth_token', value: process.env.X_AUTH_TOKEN, domain: 'mobile.twitter.com', path: '/', httpOnly: true, secure: true },
          { name: 'ct0',        value: process.env.X_CT0,        domain: 'mobile.twitter.com', path: '/', httpOnly: true, secure: true },
        ]);
        await ctx.setExtraHTTPHeaders({
          'x-csrf-token': process.env.X_CT0,
          'accept-language': 'en-US,en;q=0.9',
        });
      }

      return ctx;
    };

    // uma rodada de scraping (com cookies OU guest)
    const tryScrapeOnce = async (withCookies) => {
      const context = await makeContext(withCookies);
      const page = await context.newPage();
      let pageUrl = '';
      let hitLogin = false;

      try {
        await page.goto(navUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
        pageUrl = page.url();

        // se bater em login/access → limpa e tenta guest dentro desta rodada
        if (/\/login\b|account\/access/i.test(page.url())) {
          hitLogin = true;
          console.log('[scrape] Login wall detectado; limpando cookies e tentando guest.');
          await context.clearCookies();
          await context.setExtraHTTPHeaders({});
          await page.goto(navUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
          pageUrl = page.url();
        }

        // estabiliza
        await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});

        // várias “rodadas” para listas renderizarem
        for (let round = 0; round < (isList ? 3 : 1); round++) {
          await autoScroll(page, {
            steps: isList ? Math.max(8, Math.ceil(limit / 3)) : Math.max(4, Math.ceil(limit / 6)),
            delay: isList ? 700 : 500,
          });
          // “dança” pra re-render
          await page.evaluate(() => window.scrollBy(0, -Math.floor(window.innerHeight * 0.4))).catch(() => {});
          await page.waitForTimeout(350);
          await page.evaluate(() => window.scrollBy(0, Math.floor(window.innerHeight * 0.6))).catch(() => {});
          await page.waitForTimeout(500);
        }

        // seletor primário
        let selector = 'div[data-testid="cellInnerDiv"] article, main article, article';
        let countPrimary = await page.$$(selector).then(n => n.length);

        // fallback de seletor
        if (countPrimary === 0) {
          selector = '[data-testid="tweet"], div[role="group"] [data-testid="tweet"]';
          countPrimary = await page.$$(selector).then(n => n.length);
        }
        if (countPrimary === 0) {
          await page.waitForTimeout(1500);
          countPrimary = await page.$$(selector).then(n => n.length);
        }

        const rawItems = await page.$$eval(
          selector,
          (nodes, opts) => {
            const max = opts.max;
            const wantUser = opts.wantUser;
            const out = [];

            const getText = (root) => {
              const tt = root.querySelector('div[data-testid="tweetText"]');
              if (tt && tt.innerText) return tt.innerText.trim();
              const langDivs = root.querySelectorAll('div[lang]');
              if (langDivs && langDivs.length) {
                return Array.from(langDivs).map(el => el.innerText?.trim()).filter(Boolean).join('\n');
              }
              return '';
            };

            for (const a of nodes) {
              const link = a.querySelector('a[href*="/status/"]');
              const href = link?.getAttribute('href') || '';
              let id = href.split('/status/')[1]?.split('?')[0] || null;
              const fullUrl = href ? `https://x.com${href}` : null;

              const text = getText(a);

              let username = null;
              if (wantUser) {
                const uA1 = a.querySelector('[data-testid="User-Name"] a[href^="/"]');
                const uHref = uA1?.getAttribute('href') || '';
                if (uHref) username = uHref.replace(/^\//, '').split('/')[0] || null;
              }

              if (id && fullUrl) out.push({ id, url: fullUrl, text, username });
              if (out.length >= max) break;
            }

            // dedup por id (ignora /photo/1 no final)
            const seen = new Set();
            return out.filter(it => {
              const key = it.id.replace(/\/photo\/\d+$/, '');
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            });
          },
          { max: limit, wantUser: withUser }
        );

        return { items: rawItems, pageUrl, mode: withCookies ? 'cookies' : 'guest', hitLogin };
      } finally {
        await context.close().catch(() => {});
      }
    };

    // 1) tenta como o usuário pediu (cookies por padrão)
    let result = await tryScrapeOnce(useCookiesRequested);

    // 2) se tentou cookies e veio 0 → cai para guest
    if (useCookiesRequested && result.items.length === 0) {
      const fallback = await tryScrapeOnce(false);
      if (fallback.items.length >= result.items.length) result = fallback;
    }

    // 3) limpa contadores (se pedido)
    const items = result.items.map(it => ({
      ...it,
      text: includeCounters ? it.text : stripCountersAtEnd(it.text),
    }));

    const payload = { count: items.length, items };
    if (debug) {
      payload.meta = {
        pageUrl: result.pageUrl,
        mode: result.mode,          // 'cookies' ou 'guest'
        isList,
        usedCookiesInitially: useCookiesRequested,
        hitLogin: !!result.hitLogin, // true se caiu na tela de login
      };
    }

    res.json(payload);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err?.message || err) });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

/* ---------- start ---------- */

app.listen(PORT, () => {
  console.log(`✅ X-Scraper API listening on :${PORT}`);
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));