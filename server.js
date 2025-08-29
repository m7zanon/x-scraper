// server.js (CommonJS)
const express = require('express');
const { chromium } = require('playwright');

const app = express();
const PORT = process.env.PORT || 3000;

// --- util: remover contadores no fim do texto (ex.: " 1 23 4.5K")
function stripCountersAtEnd(text) {
  if (!text) return text;
  return text.replace(/\s*(\d+(?:[.,]\d+)?[kKmM]?\s*)+$/u, '').trim();
}

app.get('/', (_req, res) => res.type('text/plain').send('X-Scraper API is running 🚀'));
app.get('/healthz', (_req, res) => res.type('text/plain').send('ok'));

app.get('/scrape', async (req, res) => {
  const url = (req.query.url || '').toString();
  if (!url) return res.status(400).json({ error: 'Missing ?url=' });

  // parâmetros
  const limit           = parseInt((req.query.limit || '30').toString(), 10);
  const withUser        = ['1','true'].includes((req.query.withUser || '').toString());
  const includeCounters = ['1','true'].includes((req.query.includeCounters || '').toString());
  const headless        = !(['0','false'].includes((req.query.headless || '').toString()));
  const timeoutMs       = parseInt((req.query.timeout || '30000').toString(), 10);

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

    // Cookies do X (opcional, mas recomendável)
    if (process.env.X_AUTH_TOKEN && process.env.X_CT0) {
      await context.addCookies([
        { name: 'auth_token', value: process.env.X_AUTH_TOKEN, domain: '.x.com', path: '/', httpOnly: true, secure: true },
        { name: 'ct0',        value: process.env.X_CT0,        domain: '.x.com', path: '/', httpOnly: true, secure: true },
        { name: 'auth_token', value: process.env.X_AUTH_TOKEN, domain: '.twitter.com', path: '/', httpOnly: true, secure: true },
        { name: 'ct0',        value: process.env.X_CT0,        domain: '.twitter.com', path: '/', httpOnly: true, secure: true },
      ]);
      await context.setExtraHTTPHeaders({ 'x-csrf-token': process.env.X_CT0 });
    }

    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'networkidle', timeout: timeoutMs });

    // Garante que tem algo carregado
    await page.waitForSelector('article a[href*="/status/"]', { timeout: 15000 }).catch(() => {});

    const rawItems = await page.$$eval(
      'article',
      (articles, max, wantUser) => {
        const out = [];
        for (const a of articles) {
          // URL/ID
          const statusA = a.querySelector('a[href*="/status/"]');
          const href = statusA?.getAttribute('href') || '';
          const id = href.split('/status/')[1]?.split('?')[0] || null;
          const fullUrl = href ? `https://x.com${href}` : null;

          // Texto visível do tweet
          const textEl = a.querySelector('div[data-testid="tweetText"]');
          const text = textEl ? textEl.innerText.trim() : '';

          // Handle (@username)
          let username = null;
          if (wantUser) {
            const uA = a.querySelector('[data-testid="User-Name"] a[href^="/"]');
            if (uA) {
              const p = uA.getAttribute('href') || '';
              username = p.replace(/^\//, '').split('/')[0] || null;
            }
          }

          if (id && fullUrl) {
            out.push({ id, url: fullUrl, text, username });
          }
          if (out.length >= max) break;
        }
        // dedup por id
        const seen = new Set();
        return out.filter(it => (seen.has(it.id) ? false : (seen.add(it.id), true)));
      },
      limit,
      withUser
    );

    const items = rawItems.map(it => ({
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

// graceful shutdown
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));