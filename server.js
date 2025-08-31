// server.js (CommonJS)
const express = require('express');
const { chromium } = require('playwright');

const app = express();
const PORT = process.env.PORT || 3000;

// ---- helpers ----
function stripCountersAtEnd(text) {
  if (!text) return text;
  return text.replace(/\s*(\d+(?:[.,]\d+)?[kKmM]?\s*)+$/u, '').trim();
}
function toBool(v, def = true) {
  if (v === undefined || v === null) return def;
  const s = String(v).toLowerCase();
  return !(s === '0' || s === 'false' || s === 'no');
}
function toInt(v, def) {
  const n = parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : def;
}

app.get('/', (_req, res) => res.type('text/plain').send('X-Scraper API is running 🚀'));
app.get('/healthz', (_req, res) => res.type('text/plain').send('ok'));

// ----------------- SCRAPE -----------------
app.get('/scrape', async (req, res) => {
  // entrada obrigatória
  const url = (req.query.url || '').toString();
  if (!url) return res.status(400).json({ error: 'Missing ?url=' });

  // parâmetros (query vence ENV)
  const limit           = toInt(req.query.limit, 30);
  const withUser        = toBool(req.query.withUser, false);
  const includeCounters = toBool(req.query.includeCounters, false);
  const headless        = toBool(req.query.headless, toBool(process.env.HEADLESS, true));
  const timeoutMs       = toInt(req.query.timeout, 30000);

  // scroll/tempo
  const maxScrolls      = toInt(req.query.scrolls, toInt(process.env.MAX_SCROLLS, 6));
  const scrollDelayMs   = toInt(req.query.delay,   toInt(process.env.SCROLL_DELAY_MS, 1100));

  let browser;
  try {
    browser = await chromium.launch({
      headless,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    const context = await browser.newContext({
      userAgent:
        process.env.USER_AGENT ||
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    });

    // Cookies do X (opcional, mas recomendável se a lista exige login)
    if (process.env.X_AUTH_TOKEN && process.env.X_CT0) {
      await context.addCookies([
        { name: 'auth_token', value: process.env.X_AUTH_TOKEN, domain: '.x.com', path: '/', httpOnly: true, secure: true },
        { name: 'ct0',        value: process.env.X_CT0,        domain: '.x.com', path: '/', httpOnly: true, secure: true },
        // compat twitter.com
        { name: 'auth_token', value: process.env.X_AUTH_TOKEN, domain: '.twitter.com', path: '/', httpOnly: true, secure: true },
        { name: 'ct0',        value: process.env.X_CT0,        domain: '.twitter.com', path: '/', httpOnly: true, secure: true },
      ]);
      await context.setExtraHTTPHeaders({ 'x-csrf-token': process.env.X_CT0 });
    }

    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.max(timeoutMs, 45000) });

    // espera aparecer o feed/qualquer tweet
    await page.waitForSelector('article', { timeout: 15000 }).catch(() => {});

    // função que coleta tweets visíveis
    async function collectOnPage() {
      return page.$$eval('article', (articles, wantUser) => {
        const out = [];
        for (const a of articles) {
          const statusA = a.querySelector('a[href*="/status/"]');
          const href = statusA?.getAttribute('href') || '';
          const id = href.split('/status/')[1]?.split('?')[0] || null;
          const fullUrl = href ? `https://x.com${href}` : null;

          const textEl = a.querySelector('div[data-testid="tweetText"]');
          const text = textEl ? textEl.innerText.trim() : '';

          let username = null;
          if (wantUser) {
            const uA = a.querySelector('[data-testid="User-Name"] a[href^="/"]');
            if (uA) {
              const p = uA.getAttribute('href') || '';
              username = p.replace(/^\//, '').split('/')[0] || null;
            }
          }

          if (id && fullUrl) out.push({ id, url: fullUrl, text, username });
        }
        // dedup básico (pelo id) ainda dentro da página
        const seen = new Set();
        return out.filter(t => (seen.has(t.id) ? false : (seen.add(t.id), true)));
      }, withUser);
    }

    // coleta incremental com scroll
    const seen = new Set();
    const acc = [];

    async function mergeBatch(batch) {
      for (const t of batch) {
        if (!seen.has(t.id)) {
          seen.add(t.id);
          acc.push(t);
          if (acc.length >= limit) break;
        }
      }
    }

    // 1ª coleta sem rolar
    await mergeBatch(await collectOnPage());

    // rolar X vezes ou até bater o limit
    for (let i = 0; i < maxScrolls && acc.length < limit; i++) {
      await page.mouse.wheel(0, 2500);
      await page.waitForTimeout(scrollDelayMs);
      await mergeBatch(await collectOnPage());
    }

    const items = acc.slice(0, limit).map(it => ({
      ...it,
      text: includeCounters ? it.text : stripCountersAtEnd(it.text),
    }));

    res.json({ count: items.length, items });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err?.message || err) });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

app.listen(PORT, () => {
  console.log(`✅ X-Scraper API listening on :${PORT}`);
});
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));