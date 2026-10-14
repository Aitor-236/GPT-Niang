// Quote pool: the bundled list plus the user's own lines.

import fs from 'node:fs';
import path from 'node:path';

export function readBuiltinQuotes(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    const quotes = Array.isArray(parsed?.quotes) ? parsed.quotes : [];
    return quotes
      .filter(quote => quote && typeof quote.text === 'string' && quote.text.trim().length > 0)
      .map(quote => ({text: quote.text, weight: Number.isFinite(Number(quote.weight)) && Number(quote.weight) > 0 ? Number(quote.weight) : 1}));
  } catch {
    return [];
  }
}

export function customQuotesFile(dir) {
  return path.join(dir, 'quotes.json');
}

export function readCustomQuotes(dir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(customQuotesFile(dir), 'utf8').replace(/^\uFEFF/, ''));
    return Array.isArray(parsed?.quotes) ? parsed.quotes : [];
  } catch {
    return [];
  }
}

// Resetting the user's list keeps a backup first, matching the desktop build.
export function clearCustomQuotes(dir, now = Date.now()) {
  const file = customQuotesFile(dir);
  if (!fs.existsSync(file)) return null;
  const backup = file + '.backup-' + now + '.json';
  fs.renameSync(file, backup);
  return backup;
}

export function writeCustomQuotes(dir, quotes) {
  const normalized = (Array.isArray(quotes) ? quotes : [])
    .map(quote => (typeof quote === 'string' ? {text: quote, weight: 1} : quote))
    .filter(quote => quote && typeof quote.text === 'string' && quote.text.trim().length > 0)
    .map(quote => ({text: quote.text.trim(), weight: Number.isFinite(Number(quote.weight)) && Number(quote.weight) > 0 ? Number(quote.weight) : 1}));
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(customQuotesFile(dir), JSON.stringify({version: 1, quotes: normalized}, null, 2) + '\n');
  return normalized;
}

// Weighted pick with tabu on the previous line so a tap never repeats itself
// twice in a row when the pool has more than one line.
export function pickQuote(quotes, {previous = null, random = Math.random} = {}) {
  const pool = quotes.filter(quote => quote && typeof quote.text === 'string' && quote.text.length > 0);
  if (pool.length === 0) return null;
  const eligible = pool.length > 1 ? pool.filter(quote => quote.text !== previous) : pool;
  const total = eligible.reduce((sum, quote) => sum + (quote.weight > 0 ? quote.weight : 1), 0);
  let roll = random() * total;
  for (const quote of eligible) {
    roll -= quote.weight > 0 ? quote.weight : 1;
    if (roll <= 0) return quote.text;
  }
  return eligible[eligible.length - 1].text;
}
