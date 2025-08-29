import { PlaywrightCrawler, Dataset, log, sleep } from 'crawlee';
import { chromium } from 'playwright';

const MAX_SCROLLS = Number(process.env.MAX_SCROLLS || 10);
const SCROLL_DELAY_MS = Number(process.env.SCROLL_DELAY_MS || 1200);
const HEADLESS = process.env.HEADLESS !== 'false';

function buildCookiesForX() {
  const cookies = [];
  if (process.env.X_AUTH_TOKEN) cookies.push({ name: 'auth_token', value: process.env.X_AUTH_TOKEN, domain: '.x.com', path: '/' });
  if (process.env.X_CT0) cookies.push({ name: 'ct0', value: process.env.X_CT0, domain: '.x.com', path: '/' });
  return cookies;
}

const extractTweets = async (page) => {
  await page.waitForSelector('[data-testid="tweet"], article[role="article"]', { timeout: 20000 });
  const items = await page.$$eval('article[role="article"]', (articles) => {
    const out = [];
    for (const el of articles) {
      try {
        const time = el.querySelector('time');
        const datetime = time?.getAttribute('datetime') ?? null;

        const textNodes = Array.from(el.querySelectorAll('[data-testid="tweetText"]'));
        const text = textNodes.map(n => n.innerText.trim()).join('\n').trim();

        const a = Array.from(el.querySelectorAll('a')).find(l => /\/status\/\d+/.test(l.getAttribute('href') || ''));
        let url = a ? a.href : null;
        let id = url?.match(/status\/(\d+)/)?.[1] || null;

        const userA = Array.from(el.querySelectorAll('a')).find(l => /^https?:\/\/(x|twitter)\.com\/[^\/]+$/.test(l.href));
        const username = userA ? userA.href.split('/').pop() : null;

        const aria = sel => el.querySelector(sel)?.getAttribute('aria-label') || '';
        const metrics = { _raw: [aria('[data-testid="reply"]'), aria('[data-testid="retweet"]'), aria('[data-testid="like"]')].join('|') };

        if (id && url) out.push({ id, url, text, username, createdAt: datetime, metrics, isRetweet: !!el.querySelector('[data-testid="socialContext"]'), scrapedAt: new Date().toISOString() });
      } catch {}
    }
    return out.filter(t => t.id && t.url);
  });
  return Array.from(new Map(items.map(t => [t.id, t])).values());
};

export async function scrapeOnce(startUrl) {
  const crawler = new PlaywrightCrawler({
    launchContext: {
      launcher: chromium,
      launchOptions: { headless: HEADLESS, args: process.env.HTTP_PROXY ? [`--proxy-server=${process.env.HTTP_PROXY}`] : [] }
    },
    requestHandlerTimeoutSecs: 120,
    maxRequestsPerCrawl: 1,
    preNavigationHooks: [async ({ page }) => {
      const cookies = buildCookiesForX();
      if (cookies.length) await page.context().addCookies(cookies);
    }],
    requestHandler: async ({ page, log }) => {
      log.info(`Abrindo: ${startUrl}`);
      await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });

      let all = [];
      for (let i = 0; i < MAX_SCROLLS; i++) {
        const chunk = await extractTweets(page);
        all = [...all, ...chunk];
        await Dataset.pushData(chunk);
        await page.mouse.wheel(0, 2000);
        await sleep(SCROLL_DELAY_MS);
      }
      return Array.from(new Map(all.map(t => [t.id, t])).values());
    },
  });

  let result = [];
  await crawler.run([startUrl], { requestHandler: async (ctx, next) => { result = await ctx.requestHandler(ctx); await next(); } });
  return result;
}