import express from 'express';
import dotenv from 'dotenv';
import { scrapeOnce } from './main.js';
dotenv.config();

const app = express();
app.get('/healthz', (_, res) => res.send('ok'));

app.get('/scrape', async (req, res) => {
  try {
    const url = req.query.url;
    if (!url) return res.status(400).json({ error: 'Missing ?url=' });
    const data = await scrapeOnce(url);
    res.json({ count: data.length, items: data });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Scrape failed' });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`x-scraper listening on :${port}`));