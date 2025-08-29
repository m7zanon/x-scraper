// server.js
const express = require('express');
const { runScraper } = require('./main');

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (_req, res) => res.send('X-Scraper API is running 🚀'));
app.get('/healthz', (_req, res) => res.send('ok'));

// GET /scrape?url=<alvo>&maxScrolls=10&delayMs=1200
app.get('/scrape', async (req, res) => {
  try {
    const url = req.query.url;
    if (!url) return res.status(400).json({ error: 'missing url' });

    const maxScrolls = Number(req.query.maxScrolls || process.env.MAX_SCROLLS || 10);
    const delayMs = Number(req.query.delayMs || process.env.SCROLL_DELAY_MS || 1200);

    const items = await runScraper(url, { maxScrolls, delayMs });
    res.json({ count: items.length, items });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.listen(PORT, () => {
  console.log(`✅ X-Scraper API listening on :${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));