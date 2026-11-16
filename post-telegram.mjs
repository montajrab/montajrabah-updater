// MontajRabah - Telegram channel poster
// Reads the REAL data written by fetch-products.mjs (data/products.json) and posts the best
// products to a Telegram channel through the Bot API. Optional real coupons come from
// data/coupons.json, a file YOU edit by hand (nothing is ever invented by this script).
//
// Secrets (GitHub): TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID (e.g. @my_channel)
// Optional (GitHub Variables or env): SITE_URL, USD_DZD_RATE, MAX_POSTS, MAX_COUPONS,
//                                     MIN_SCORE, REPOST_DAYS, DRY_RUN, POST_DELAY_MS

import fs from 'node:fs';
import path from 'node:path';

const {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  SITE_URL = 'https://www.montajrabah.com',
  USD_DZD_RATE,
  DRY_RUN,
} = process.env;

const MAX_POSTS = Math.max(0, parseInt(process.env.MAX_POSTS ?? '50', 10) || 0);
const MAX_COUPONS = Math.max(0, parseInt(process.env.MAX_COUPONS ?? '1', 10) || 0);
const MIN_SCORE = parseInt(process.env.MIN_SCORE ?? '80', 10) || 80;
const REPOST_DAYS = parseInt(process.env.REPOST_DAYS ?? '30', 10) || 30;
const MIN_RATING = 4.3; // products with a known rating below this are never posted
const DELAY_MS = Number(process.env.POST_DELAY_MS ?? 1500);
const dryRun = ['1', 'true', 'yes'].includes(String(DRY_RUN || '').toLowerCase());

const DATA_DIR = path.resolve(process.cwd(), process.env.DATA_DIR || 'data');
const PRODUCTS_PATH = path.join(DATA_DIR, 'products.json');
const POSTED_PATH = path.join(DATA_DIR, 'posted.json');
const COUPONS_PATH = path.join(DATA_DIR, 'coupons.json');

if (!dryRun && (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID)) {
  console.log('Telegram is not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID missing): skipping.');
  process.exit(0);
}

// ---------- helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Algiers' }).format(new Date()); // YYYY-MM-DD
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const isHttps = (u) => typeof u === 'string' && /^https:\/\/[^\s]+$/.test(u);

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function shortTitle(t, max = 70) {
  const s = String(t || '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const i = cut.lastIndexOf(' ');
  return (i > 40 ? cut.slice(0, i) : cut).replace(/[,\-–|/\s]+$/, '') + '…';
}

const FOOTER =
  '⚠️ السعر تقريبي وقد يختلف عند الشراء، .\n' +
  '';

function productCaption(p, titleMax = 70) {
  const price = Number(p.price);
  const lines = [];
  lines.push(`🔥 <b>منتج رائج</b> | ${esc(p.category || '')}`);
  lines.push('');
  lines.push(esc(shortTitle(p.title, titleMax)));
  lines.push('');
  if (price > 0) {
    let priceLine = `💰 السعر: $${price.toFixed(2)}`;
    const rate = parseFloat(USD_DZD_RATE);
    if (rate > 0) priceLine += ` (≈ ${(Math.round((price * rate) / 10) * 10).toLocaleString('en-US')} دج بسعر صرف ${rate})`;
    lines.push(priceLine);
  }
  const stats = [];
  if (typeof p.rating === 'number' && p.rating > 0) stats.push(`⭐ ${p.rating.toFixed(1)}`);
  if (typeof p.orders === 'number' && p.orders > 0) stats.push(`🛒 ${p.orders.toLocaleString('en-US')} طلب`);
  if (stats.length) lines.push(stats.join(' | '));
  if (typeof p.orders7dGrowth === 'number' && p.orders7dGrowth > 0) lines.push(`📈 نمو الطلبات خلال 7 أيام: +${p.orders7dGrowth}%`);
  if (typeof p.score === 'number') lines.push(`📊 سكور الموقع: ${p.score}/100`);
  lines.push('');
  lines.push(`👉 <a href="${esc(p.productUrl)}">عرض المنتج على AliExpress</a>`);
  lines.push(`🧮 احسب ربحك بالدينار: ${esc(SITE_URL)}`);
  lines.push('');
  lines.push(FOOTER);
  return lines.join('\n');
}

function couponText(c) {
  const lines = [];
  lines.push('🎟 <b>كوبون / عرض</b>');
  lines.push('');
  lines.push(esc(c.title));
  if (c.code) lines.push(`الكود: <code>${esc(c.code)}</code>`);
  if (c.details) lines.push(esc(c.details));
  if (c.minSpend) lines.push(`الحد الأدنى للشراء: ${esc(c.minSpend)}`);
  lines.push(`⏳ صالح حتى: ${esc(c.validUntil)}`);
  lines.push('');
  lines.push(`👉 <a href="${esc(c.link)}">رابط العرض</a>`);
  lines.push('');
  lines.push('⚠️ شروط الكوبونات تتغير وقد تنتهي مبكراً. تحقق من الصفحة قبل الشراء.');
  return lines.join('\n');
}

async function tg(method, payload) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let json;
    try {
      const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      json = await res.json();
    } catch {
      return { ok: false, description: 'network error' }; // never print the error: it could include the URL/token
    }
    if (json?.ok) return json;
    if (json?.error_code === 429) {
      const wait = (json.parameters?.retry_after ?? 5) + 1;
      console.warn(`Telegram rate limit, waiting ${wait}s`);
      await sleep(wait * 1000);
      continue;
    }
    return json || { ok: false, description: 'unknown error' };
  }
  return { ok: false, description: 'rate limited' };
}

// ---------- load data ----------
const productsFile = readJson(PRODUCTS_PATH, null);
const products = Array.isArray(productsFile?.products) ? productsFile.products : [];
if (!products.length) {
  console.error('data/products.json is missing or empty: nothing to post.');
  process.exit(1);
}

const postedFile = readJson(POSTED_PATH, { posted: {} });
const posted = postedFile && typeof postedFile.posted === 'object' && postedFile.posted ? postedFile.posted : {};
for (const [k, d] of Object.entries(posted)) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d)) || daysBetween(d, today) > 120) delete posted[k]; // keep the file small
}

// ---------- pick products ----------
const eligible = products.filter((p) => {
  if (!p || !p.id || !isHttps(p.productUrl) || !isHttps(p.imageUrl)) return false;
  if (typeof p.score !== 'number' || p.score < MIN_SCORE) return false;
  if (typeof p.rating === 'number' && p.rating > 0 && p.rating < MIN_RATING) return false;
  const last = posted[String(p.id)];
  if (last && daysBetween(last, today) < REPOST_DAYS) return false;
  return true;
});
const growth = (p) => (typeof p.orders7dGrowth === 'number' ? p.orders7dGrowth : -1);
eligible.sort((a, b) => b.score - a.score || growth(b) - growth(a) || (b.orders || 0) - (a.orders || 0));

// category variety first, then fill
const picks = [];
const usedCats = new Set();
for (const p of eligible) {
  if (picks.length >= MAX_POSTS) break;
  if (usedCats.has(p.category)) continue;
  usedCats.add(p.category);
  picks.push(p);
}
for (const p of eligible) {
  if (picks.length >= MAX_POSTS) break;
  if (!picks.includes(p)) picks.push(p);
}

// ---------- pick coupons (hand-written real data only) ----------
const couponsRaw = readJson(COUPONS_PATH, []);
const coupons = [];
for (const c of Array.isArray(couponsRaw) ? couponsRaw : []) {
  const problems = [];
  if (!c || typeof c.title !== 'string' || !c.title.trim()) problems.push('title missing');
  if (!isHttps(c?.link)) problems.push('link must start with https://');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(c?.validUntil || ''))) problems.push('validUntil must be YYYY-MM-DD');
  if (problems.length) {
    console.warn(`Skipping invalid coupon "${c?.title || c?.code || '?'}": ${problems.join(', ')}`);
    continue;
  }
  if (c.validUntil < today) continue; // expired
  const key = `coupon:${(c.code || c.title).toString().trim().toLowerCase()}`;
  if (posted[key]) continue;
  coupons.push({ ...c, key });
}
const couponPicks = coupons.slice(0, MAX_COUPONS);

console.log(
  `Today (Algiers): ${today} | eligible products: ${eligible.length} -> posting ${picks.length} | active coupons: ${coupons.length} -> posting ${couponPicks.length}` +
    (dryRun ? ' | DRY RUN (nothing is sent)' : '')
);

// ---------- post ----------
let attempted = 0;
let succeeded = 0;

for (const c of couponPicks) {
  const text = couponText(c);
  attempted++;
  if (dryRun) {
    console.log('\n--- COUPON ---\n' + text + '\n');
    succeeded++;
  } else {
    const r = await tg('sendMessage', { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true });
    if (r.ok) { posted[c.key] = today; succeeded++; } else console.error(`Coupon post failed: ${r.description}`);
    await sleep(DELAY_MS);
  }
}

for (const p of picks) {
  let caption = productCaption(p);
  if (caption.length > 1000) caption = productCaption(p, 45); // Telegram caption limit is 1024
  attempted++;
  if (dryRun) {
    console.log(`\n--- PRODUCT ${p.id} (score ${p.score}) ---\n${caption}\n[photo: ${p.imageUrl}]\n`);
    succeeded++;
    continue;
  }
  let r = await tg('sendPhoto', { chat_id: TELEGRAM_CHAT_ID, photo: p.imageUrl, caption, parse_mode: 'HTML' });
  if (!r.ok) {
    console.warn(`sendPhoto failed for ${p.id} (${r.description}); sending text instead`);
    r = await tg('sendMessage', { chat_id: TELEGRAM_CHAT_ID, text: caption, parse_mode: 'HTML', disable_web_page_preview: true });
  }
  if (r.ok) { posted[String(p.id)] = today; succeeded++; } else console.error(`Product post failed for ${p.id}: ${r.description}`);
  await sleep(DELAY_MS);
}

if (!dryRun && succeeded > 0) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(POSTED_PATH, JSON.stringify({ posted }, null, 2), 'utf8');
}

console.log(`Done: ${succeeded}/${attempted} posted.`);
if (attempted > 0 && succeeded === 0) process.exit(1); // make the workflow fail visibly
process.exit(0);
