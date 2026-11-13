import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const { ALI_APP_KEY, ALI_APP_SECRET, ALI_TRACKING_ID } = process.env;

for (const [k, v] of Object.entries({
  ALI_APP_KEY,
  ALI_APP_SECRET,
  ALI_TRACKING_ID,
})) {
  if (!v) {
    console.error(`Missing secret: ${k}`);
    process.exit(1);
  }
}

// Items restricted or banned for import into Algeria
const RESTRICTED =
  /(drone|quadcopter|uav|spy|hidden camera|mini camera|wifi camera|surveillance|listening|wiretap|\bgps\b|gps tracker|spy gps|car tracker|walkie|jammer|signal blocker|laser pointer|laser pen|stun|taser|pepper spray|knife|dagger|sword|crossbow|slingshot|airsoft|gun|pistol|rifle|ammo|supplement|capsule|pills?|tablet pill|medicine|weight loss|slimming|viagra|vape|e-?cig|cigarette|tobacco|hookah|counterfeit|replica|fake)/i;

// Fragile items (lowers suitability, does not exclude)
const FRAGILE = /(glass|ceramic|perfume|liquid|oil|spray|lithium|battery|power bank)/i;

const clamp = (x, a = 0, b = 100) => Math.max(a, Math.min(b, x));

function computeScore(p, growth) {
  const reasons = [];

  const ordersPts = clamp((Math.log10(p.orders + 1) / Math.log10(20000)) * 100);
  const demand = growth === null ? ordersPts : 0.6 * ordersPts + 0.4 * clamp(growth * 5);
  reasons.push(p.orders >= 1000 ? 'طلب مرتفع' : 'طلب متوسط أو منخفض');
  if (growth !== null && growth > 5) reasons.push('الطلب في ازدياد');

  const pr = p.price;
  const profit = pr < 2 ? 30 : pr < 5 ? 70 : pr <= 15 ? 100 : pr <= 30 ? 70 : 40;
  reasons.push(pr >= 5 && pr <= 15 ? 'سعر مناسب لهامش ربح جيد' : 'تحقق من هامش الربح بالحاسبة');

  const fragile = FRAGILE.test(p.title);
  const suitability = fragile ? 40 : 80;
  if (fragile) reasons.push('قد يكون هشاً أو مقيداً في الشحن/الاستيراد');

  const supplier = p.rating ? clamp(((p.rating - 3.5) / 1.5) * 100) : 40;
  reasons.push(p.rating && p.rating >= 4.5 ? 'تقييم مورد ممتاز' : 'تقييم مورد متوسط');

  const score = Math.round((0.3 * demand + 0.25 * profit + 0.15 * suitability + 0.15 * supplier) / 0.85);

  return {
    score,
    scoreBreakdown: {
      demand: Math.round(demand),
      profit: Math.round(profit),
      suitability: Math.round(suitability),
      supplier: Math.round(supplier),
    },
    scoreReasons: reasons,
  };
}

function normalizeCategory(rawCategory = '', title = '') {
  const c = (rawCategory || '').toLowerCase();
  const t = (title || '').toLowerCase();

  // 1) Phones & Tablets
  if (
    c.includes('tablet') ||
    t.includes('tablet') ||
    t.includes('ipad') ||
    t.includes('smartphone') ||
    t.includes('cellphone') ||
    (t.includes('phone') && (t.includes('android') || t.includes('unlocked') || t.includes('5g') || t.includes('4g') || /\bram\b/i.test(t) || t.includes('rom'))) ||
    (c.includes('phone') && !c.includes('accessor') && (t.includes('phone') || t.includes('pro') || t.includes('ultra') || t.includes('mini')))
  ) {
    return 'الهواتف والأجهزة اللوحية';
  }

  // 2) PC & Computer Components
  if (
    c.includes('component') ||
    t.includes('motherboard') ||
    t.includes('graphics card') ||
    t.includes('gpu') ||
    t.includes('cpu') ||
    t.includes('processor') ||
    /\bram\b/i.test(t) ||
    t.includes('ddr4') ||
    t.includes('ddr5') ||
    t.includes('nvme') ||
    /\bssd\b/i.test(t) ||
    t.includes('hard drive') ||
    t.includes('cooling fan') ||
    t.includes('power supply') ||
    (/\bpc\b/i.test(t) && t.includes('case')) ||
    (/\bpc\b/i.test(t) && t.includes('desktop')) ||
    t.includes('laptop') ||
    (c.includes('computer') && (/\bmouse\b/i.test(t) || t.includes('keyboard') || /\bpc\b/i.test(t) || t.includes('hub') || t.includes('dock') || t.includes('drive')))
  ) {
    return 'الكمبيوتر والقطع والملحقات';
  }

  // 3) Car Accessories
  if (c.includes('auto') || c.includes('car') || c.includes('motor') || t.includes('car') || t.includes('vehicle')) {
    return 'إكسسوارات ولوازم السيارات';
  }

  // 4) Phone Accessories
  if (c.includes('phone') || c.includes('telecom') || t.includes('phone') || t.includes('charger') || t.includes('cable') || t.includes('holder') || t.includes('screen protector')) {
    return 'ملحقات الهواتف والاتصالات';
  }

  // 5) Smart Electronics
  if (c.includes('electron') || t.includes('bluetooth') || t.includes('speaker') || t.includes('earphone') || t.includes('headphone') || t.includes('tws') || /\btv\b/i.test(t) || t.includes('humidifier') || t.includes('purifier')) {
    return 'إلكترونيات وأجهزة ذكية';
  }

  // 6) Kitchen & Cooking
  if (
    c.includes('kitchen') ||
    t.includes('kitchen') ||
    t.includes('knife') ||
    t.includes('cook') ||
    t.includes('mug') ||
    t.includes('cup') ||
    t.includes('blender') ||
    t.includes('slicer') ||
    t.includes('peeler') ||
    t.includes('grater') ||
    t.includes('baking') ||
    t.includes('tongs') ||
    t.includes('sprayer') ||
    t.includes('crusher') ||
    t.includes('shredder') ||
    t.includes('chopper') ||
    t.includes('spatula') ||
    t.includes('bakeware') ||
    t.includes('fryer') ||
    t.includes('fork') ||
    t.includes('beater')
  ) {
    return 'المطبخ وأدوات الطهي';
  }

  // 7) Lighting & Decor
  if (c.includes('light') || c.includes('lamp') || /\bled\b/i.test(t) || t.includes('light') || t.includes('lamp') || t.includes('strip') || t.includes('switch') || t.includes('sensor')) {
    return 'إضاءة وديكور حديث';
  }

  // 8) Beauty & Personal Care
  if (c.includes('beauty') || c.includes('health') || c.includes('hair') || t.includes('hair') || t.includes('trimmer') || t.includes('shaver') || t.includes('clipper') || t.includes('massage') || t.includes('facial') || t.includes('makeup')) {
    return 'العناية الشخصية والجمال';
  }

  // 9) Tools & Equipment
  if (c.includes('tool') || c.includes('improvement') || c.includes('industrial') || t.includes('blower') || t.includes('cleaner') || t.includes('brush') || t.includes('repair') || t.includes('drill') || t.includes('screwdriver') || t.includes('wrench')) {
    return 'أدوات ومعدات وتصليح';
  }

  // 10) Smart Watches & Jewelry
  if (c.includes('watch') || t.includes('watch') || t.includes('smartwatch') || c.includes('jewel') || c.includes('ring') || c.includes('necklace') || c.includes('bracelet') || c.includes('earring')) {
    return 'ساعات وإكسسوارات ذكية';
  }

  // 11) Sports & Outdoors
  if (c.includes('sport') || c.includes('outdoor') || t.includes('fitness') || t.includes('gym') || t.includes('camp') || t.includes('cycling') || t.includes('yoga') || t.includes('workout')) {
    return 'رياضة وتخييم ولياقة';
  }

  // 12) Bags & Organizers
  if (c.includes('bag') || c.includes('luggage') || t.includes('backpack') || t.includes('wallet') || t.includes('organizer') || t.includes('pouch') || t.includes('suitcase')) {
    return 'حقائب ومستلزمات التنظيم';
  }

  // 13) Toys & Kids
  if (c.includes('toy') || c.includes('kid') || c.includes('baby') || c.includes('mother') || t.includes('toy') || t.includes('puzzle') || t.includes('doll')) {
    return 'ألعاب ومستلزمات أطفال';
  }

  // 14) Bathroom & Storage
  if (c.includes('bath') || c.includes('shower') || t.includes('towel') || t.includes('soap') || t.includes('toilet') || t.includes('bathroom')) {
    return 'مستلزمات الحمام والتنظيم';
  }

  // 15) Home & Decor
  if (c.includes('garden') || c.includes('home') || t.includes('tissue') || /\bbox\b/i.test(t) || t.includes('decor') || /\bmat\b/i.test(t) || t.includes('tray') || t.includes('cover')) {
    return 'المنزل والديكور العصري';
  }

  return rawCategory.trim() || 'أخرى';
}

function sign(params) {
  const base = Object.keys(params)
    .sort()
    .map((k) => k + params[k])
    .join('');
  return crypto.createHmac('sha256', ALI_APP_SECRET).update(base).digest('hex').toUpperCase();
}

function chinaTime() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

const TIMESTAMP_FORMATS = [() => String(Date.now()), chinaTime];

async function callAliApi(method, extra) {
  const API_URL = 'https://api-sg.aliexpress.com/sync';
  let lastJson = null;

  for (let i = 0; i < TIMESTAMP_FORMATS.length; i++) {
    const params = {
      app_key: ALI_APP_KEY,
      timestamp: TIMESTAMP_FORMATS[i](),
      sign_method: 'sha256',
      method,
      ...extra,
    };
    params.sign = sign(params);

    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
      body: new URLSearchParams(params),
    });

    lastJson = await res.json();
    const msg = JSON.stringify(lastJson).toLowerCase();
    const timeProblem = msg.includes('timestamp') || msg.includes('invalid sign');

    if (lastJson?.error_response && timeProblem && i < TIMESTAMP_FORMATS.length - 1) {
      continue;
    }
    return lastJson;
  }
  return lastJson;
}

async function main() {
  const raw = [];
  const apiErrors = [];

  const hotTasks = [];

  // 1) General hot products (pages 1 to 8)
  for (let page = 1; page <= 8; page++) {
    hotTasks.push({
      params: {
        page_no: String(page),
        page_size: '50',
        ship_to_country: 'DZ',
        target_currency: 'USD',
        target_language: 'EN',
        tracking_id: ALI_TRACKING_ID,
        sort: 'LAST_VOLUME_DESC',
      },
      label: `hotproduct-general-p${page}`,
    });
  }

  // 2) Category-specific hot products across all sectors (including Phones, Tablets, PC & Components)
  const TARGET_HOT_CATEGORIES = [
    { id: '509', pages: 4, name: 'Phones & Tablets' },
    { id: '7', pages: 4, name: 'PC & Computer Components' },
    { id: '44', pages: 3, name: 'Consumer Electronics' },
    { id: '15', pages: 3, name: 'Home & Kitchen' },
    { id: '34', pages: 3, name: 'Automotive' },
    { id: '1420', pages: 3, name: 'Tools & Home Improvement' },
    { id: '1524', pages: 3, name: 'Luggage & Bags' },
    { id: '66', pages: 3, name: 'Beauty & Personal Care' },
    { id: '1511,1509', pages: 3, name: 'Watches & Jewelry' },
    { id: '18', pages: 3, name: 'Sports & Outdoors' },
    { id: '26,1501', pages: 3, name: 'Toys & Kids' },
  ];

  for (const cat of TARGET_HOT_CATEGORIES) {
    for (let page = 1; page <= cat.pages; page++) {
      hotTasks.push({
        params: {
          category_ids: cat.id,
          page_no: String(page),
          page_size: '50',
          ship_to_country: 'DZ',
          target_currency: 'USD',
          target_language: 'EN',
          tracking_id: ALI_TRACKING_ID,
          sort: 'LAST_VOLUME_DESC',
        },
        label: `hotproduct-${cat.name}-p${page}`,
      });
    }
  }

  // Run hotproduct queries in batches of 5 concurrent requests
  const BATCH_CONCURRENCY = 5;
  for (let i = 0; i < hotTasks.length; i += BATCH_CONCURRENCY) {
    const chunk = hotTasks.slice(i, i + BATCH_CONCURRENCY);
    await Promise.all(
      chunk.map(async (task) => {
        try {
          const json = await callAliApi('aliexpress.affiliate.hotproduct.query', task.params);
          const list = json?.aliexpress_affiliate_hotproduct_query_response?.resp_result?.result?.products?.product;
          if (list && Array.isArray(list) && list.length > 0) {
            raw.push(...list);
          } else if (json?.error_response) {
            apiErrors.push({ task: task.label, error: json.error_response });
          }
        } catch (err) {
          apiErrors.push({ task: task.label, error: err?.message || String(err) });
        }
      })
    );
  }

  // Fallback: keyword search if hotproduct query returns nothing
  if (raw.length === 0) {
    const CATEGORIES_TO_SEARCH = [
      'smartphones android phones unlocked 5g cell phones',
      'tablets android tablet pad 10 inch',
      'pc computer components motherboard graphics card gpu cpu ram ssd',
      'gaming mouse mechanical keyboard rgb headset pc desktop',
      'laptop accessories cooler dock stand',
      'car accessories organizer charger interior gadget',
      'kitchen gadgets tools organizer cooking slicer',
      'phone accessories wireless charger holder magnetic',
      'smart home led motion sensor night light lamp',
      'electric cordless cleaning tools power scrubber brush',
      'beauty personal care hair clipper trimmer shaver',
      'smart watch waterproof fitness tracker bracelet',
      'home improvement multifunction drill repair tools',
      'travel portable storage bag organizer luggage',
      'baby kids educational learning drawing toys',
      'bathroom accessories soap dispenser shower organizer',
      'home decor ambient lighting modern storage box',
      'sports fitness gym workout resistance bands outdoor',
      'waterproof bluetooth speaker portable wireless sound',
      'portable blender usb rechargeable juice cup',
    ];

    for (const kw of CATEGORIES_TO_SEARCH) {
      try {
        const queryJson = await callAliApi('aliexpress.affiliate.product.query', {
          page_no: '1',
          page_size: '50',
          keywords: kw,
          ship_to_country: 'DZ',
          target_currency: 'USD',
          target_language: 'EN',
          tracking_id: ALI_TRACKING_ID,
          sort: 'LAST_VOLUME_DESC',
        });

        const queryList = queryJson?.aliexpress_affiliate_product_query_response?.resp_result?.result?.products?.product;
        if (queryList && Array.isArray(queryList) && queryList.length > 0) {
          raw.push(...queryList);
        } else if (queryJson?.error_response) {
          apiErrors.push({ kw, error: queryJson.error_response });
        }
      } catch (err) {
        apiErrors.push({ kw, error: err?.message || String(err) });
      }
    }
  }

  if (raw.length === 0) {
    console.error('AliExpress API returned 0 products:', JSON.stringify(apiErrors, null, 2));
    process.exit(1);
  }

  // Filter, deduplicate and sanitize
  const uniqueMap = new Map();
  for (const r of raw) {
    const id = String(r.product_id);
    if (!id || uniqueMap.has(id)) continue;

    const link = r.promotion_link;
    if (!link || typeof link !== 'string' || !link.startsWith('http') || link.includes('www.aliexpress.com/item/undefined')) {
      continue;
    }

    if (RESTRICTED.test(r.product_title || '')) continue;

    const ordersCount = Number(r.lastest_volume) || 0;
    if (ordersCount < 1000) continue;

    uniqueMap.set(id, r);
  }

  const items = Array.from(uniqueMap.values());
  if (items.length === 0) {
    console.error('No products met the minimum 1,000 orders and valid promotion link criteria');
    process.exit(1);
  }

  // Read existing 7-day order history from data/history.json
  const dataDir = path.resolve(process.cwd(), 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  const historyPath = path.join(dataDir, 'history.json');
  const productsPath = path.join(dataDir, 'products.json');

  let prevHistory = {};
  try {
    if (fs.existsSync(historyPath)) {
      prevHistory = JSON.parse(fs.readFileSync(historyPath, 'utf8')) || {};
    }
  } catch (err) {
    console.warn('Could not read existing data/history.json, starting fresh:', err?.message);
    prevHistory = {};
  }

  const nowIso = new Date().toISOString();
  const today = nowIso.slice(0, 10);
  const cutoffMillis = Date.now() - 7 * 24 * 3600 * 1000;

  const nextHistory = {};
  const products = [];

  for (const r of items) {
    const id = String(r.product_id);
    const prevEntry = prevHistory[id];
    const prevList = Array.isArray(prevEntry?.history) ? prevEntry.history : Array.isArray(prevEntry) ? prevEntry : [];

    const priceCandidates = [
      parseFloat(r.target_app_sale_price),
      parseFloat(r.target_sale_price),
    ].filter((val) => typeof val === 'number' && !isNaN(val) && val > 0);

    const realPrice = priceCandidates.length > 0 ? Math.min(...priceCandidates) : Number(r.target_sale_price) || 0;

    const origPriceParsed = parseFloat(r.target_original_price);
    const originalPrice =
      typeof origPriceParsed === 'number' && !isNaN(origPriceParsed) && origPriceParsed > realPrice
        ? origPriceParsed
        : null;

    const p = {
      title: r.product_title || 'منتج رابح',
      imageUrl: r.product_main_image_url || '',
      productUrl: r.promotion_link,
      category: normalizeCategory(
        r.first_level_category_name || r.second_level_category_name || '',
        r.product_title || ''
      ),
      price: realPrice,
      originalPrice,
      orders: Number(r.lastest_volume) || 0,
      rating: r.evaluate_rate ? parseFloat(r.evaluate_rate) / 20 : null,
    };

    const history = prevList.filter((h) => h && h.d && h.d !== today);
    history.push({ d: today, o: p.orders });
    const trimmed = history.slice(-8);
    const first = trimmed[0];
    const growth = trimmed.length > 1 && first && first.o > 0 ? ((p.orders - first.o) / first.o) * 100 : null;

    let shippingVal = null;
    if (typeof r.shipping_fee === 'number' && r.shipping_fee > 0) {
      shippingVal = r.shipping_fee;
    } else if (r.ship_price && !isNaN(parseFloat(r.ship_price)) && parseFloat(r.ship_price) > 0) {
      shippingVal = parseFloat(r.ship_price);
    }

    nextHistory[id] = {
      updatedAt: nowIso,
      history: trimmed,
    };

    products.push({
      id,
      ...p,
      orders7dGrowth: growth === null ? null : Math.round(growth * 10) / 10,
      shippingToDZ: shippingVal,
      deliveryDays: null,
      reviewsCount: null,
      ...computeScore(p, growth),
      updatedAt: nowIso,
    });
  }

  // Preserve recent history entries (< 7 days) for items temporarily absent today
  for (const [id, entry] of Object.entries(prevHistory)) {
    if (nextHistory[id]) continue;
    const entryTs = entry?.updatedAt ? new Date(entry.updatedAt).getTime() : 0;
    if (entryTs && entryTs >= cutoffMillis && Array.isArray(entry.history)) {
      nextHistory[id] = entry;
    }
  }

  // Sort by orders descending (matches previous Firestore ordering)
  products.sort((a, b) => (b.orders ?? 0) - (a.orders ?? 0));

  const outputPayload = {
    updatedAt: nowIso,
    count: products.length,
    products,
  };

  fs.writeFileSync(productsPath, JSON.stringify(outputPayload, null, 2), 'utf8');
  fs.writeFileSync(historyPath, JSON.stringify(nextHistory), 'utf8');

  console.log(`Successfully saved ${products.length} winning products to data/products.json`);
}

main().catch((err) => {
  console.error('Fatal error during sync:', err);
  process.exit(1);
});
