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

// ---------------------------------------------------------------------------
// Category classification
// 1) Primary signal: AliExpress category names (first + second level) matched with
//    WHOLE-WORD regexes (so "earphone" never matches "phone", "card" never matches "car").
// 2) Secondary signal: the product title, only when the category names did not decide.
// ---------------------------------------------------------------------------
const CAT = {
  PHONES: 'الهواتف والأجهزة اللوحية',
  PHONE_ACC: 'ملحقات الهواتف والاتصالات',
  SHOES: 'أحذية',
  MEN: 'ملابس رجالية',
  WOMEN: 'ملابس نسائية',
  KIDS: 'ملابس أطفال',
  UNISEX: 'ملابس للجنسين',
  FASHION_ACC: 'مجوهرات وإكسسوارات الأزياء',
  BAGS: 'حقائب ومستلزمات التنظيم',
  WATCHES: 'ساعات وإكسسوارات ذكية',
  STATIONERY: 'قرطاسية ومستلزمات مكتبية',
  CAR: 'إكسسوارات ولوازم السيارات',
  COMPUTER: 'الكمبيوتر والقطع والملحقات',
  BEAUTY: 'العناية الشخصية والجمال',
  KITCHEN: 'المطبخ وأدوات الطهي',
  ELECTRONICS: 'إلكترونيات وأجهزة ذكية',
  BATH: 'مستلزمات الحمام والتنظيم',
  LIGHTING: 'إضاءة وديكور حديث',
  TOOLS: 'أدوات ومعدات وتصليح',
  SPORTS: 'رياضة وتخييم ولياقة',
  TOYS: 'ألعاب ومستلزمات أطفال',
  HOME: 'المنزل والديكور العصري',
  OTHER: 'أخرى',
};

const KIDS_RE = /\b(kids?|children|child|baby|babies|toddlers?|infants?|newborns?|boys?|girls?|teens?|juniors?)\b/;
const WOMEN_RE = /\b(women'?s?|womens|woman|ladies|lady|female|maternity)\b/;
const MEN_RE = /\b(men'?s?|mens|man|male)\b/;

const ACC_CAT = /accessor|parts|case|cover|holder|charger|cable|protector|film|stand|strap|lens|power bank|battery|sticker|skin|stylus|antenna|adapter|dock|mount|repair/;
const ACC_TITLE = /\b(cases?|covers?|holders?|stands?|chargers?|cables?|protectors?|tempered|films?|straps?|power ?banks?|stickers?|skins?|mounts?|tripods?|gamepads?|coolers?|earphones?|headphones?|headsets?|earbuds?|replacement|repair)\b|\bfor (iphone|samsung|xiaomi|huawei|oppo|vivo|redmi|galaxy|phone|ipad|tablet)\b|\bcompatible with\b/;
const HANDSET_TITLE = /\b(smart ?phones?|cell ?phones?|mobile phones?|iphone ?\d+|galaxy [a-z]?\d+|redmi|poco|realme|tecno|infinix|oppo|vivo|honor|oneplus|android phone|dual sim|unlocked phone|5g (smart)?phone|4g (smart)?phone|\d+ ?gb ram|\d+ ?gb rom|\d+gb\+\d+gb)\b/;

const SHOES_RE = /\b(shoes?|sneakers?|boots?|sandals?|slippers?|loafers?|flip[- ]?flops?|high heels?|footwear|oxfords?|pumps|clogs|espadrilles|trainers)\b/;
const SHOE_ACC = /\b(insoles?|shoelaces?|shoe ?laces?|shoe ?care|shoe ?racks?)\b|\b(shoe|boot|sneaker)s? (accessor|care|rack|organi[sz]er|cover|polish|tree|lace|insole|horn|storage|bag|box|cleaner|brush)/;

const CLOTHES_CAT = /\b(clothing|clothes|apparel|dress(es)?|gowns?|shirts?|t-?shirts?|tees?|tops|blouses?|jackets?|coats?|parkas?|hoodies?|sweatshirts?|sweaters?|cardigans?|jeans|pants|trousers|shorts|skirts?|blazers?|vests?|underwear|panties|lingerie|sleepwear|pajamas|pyjamas|swimwear|bikinis?|leggings|jumpsuits?|rompers?|tracksuits?|sportswear|uniforms?)\b/;
const CLOTHES_TITLE = /\b(dress(es)?|shirts?|t-?shirts?|tees?|blouses?|jackets?|coats?|hoodies?|sweatshirts?|sweaters?|cardigans?|jeans|pants|trousers|shorts|skirts?|blazers?|vests?|underwear|panties|lingerie|pajamas|pyjamas|swimsuits?|bikinis?|leggings|jumpsuits?|rompers?|tracksuits?|sportswear|clothing|clothes)\b/;

const FASHION_ACC_CAT = /\bjewel(le)?ry\b|\bnecklaces?\b|\bbracelets?\b|\bearrings?\b|\bsunglasses\b|\bhair (accessories|clips?|bands?)\b|\bscarves?\b|\bhats?\b|\bcaps?\b|\bgloves?\b|\bbelts?\b|\bapparel accessor(y|ies)\b/;
const BAGS_CAT = /\b(bags?|luggage|backpacks?|wallets?|suitcases?|handbags?|purses?)\b/;
const BAGS_EXCL = /\b(sleeping|garbage|trash|tea|vacuum|plastic|shopping|gift|packaging)\b ?bags?/;

const genderOf = (s) => (KIDS_RE.test(s) ? CAT.KIDS : WOMEN_RE.test(s) ? CAT.WOMEN : MEN_RE.test(s) ? CAT.MEN : null);

function classify(first = '', second = '', title = '') {
  const norm = (s) => String(s || '').toLowerCase().replace(/[’`]/g, "'");
  const f = norm(first);
  const s2 = norm(second);
  const c = `${f} | ${s2}`;
  const t = norm(title);
  const hasCat = (f + s2).trim().length > 0;

  if (hasCat) {
    // A) Phones, tablets and phone accessories
    const inPhones = /phones? (&|and) telecom/.test(c) || /\b(mobile phones?|cell ?phones?|smartphones?)\b/.test(c);
    if (inPhones) {
      if (!ACC_CAT.test(c) && /\b(mobile phones?|cell ?phones?|smartphones?)\b/.test(s2)) return CAT.PHONES;
      if (HANDSET_TITLE.test(t) && !ACC_TITLE.test(t) && !ACC_CAT.test(c)) return CAT.PHONES;
      return CAT.PHONE_ACC;
    }
    if (/\btablets?\b/.test(c) && !ACC_CAT.test(c)) return CAT.PHONES;

    // B) Shoes
    if (SHOES_RE.test(c) && !SHOE_ACC.test(c)) return CAT.SHOES;

    // C) Jewelry & fashion accessories (before clothing: "Apparel Accessories")
    if (FASHION_ACC_CAT.test(c)) return CAT.FASHION_ACC;

    // D) Clothing by gender / age
    if (CLOTHES_CAT.test(c)) {
      const g = genderOf(c) || genderOf(t);
      if (g) return g;
      if (/\bunisex\b/.test(`${c} ${t}`)) return CAT.UNISEX;
    }

    // E) Bags & luggage
    if (BAGS_CAT.test(c) && !BAGS_EXCL.test(c)) return CAT.BAGS;

    // F) Watches & wearables
    if (/\bwatch(es)?\b|\bsmart ?watch(es)?\b|\bsmart bands?\b|\bwearable/.test(c)) return CAT.WATCHES;

    // G) Stationery
    if (/\boffice (&|and) school\b|\bstationery\b|\bnotebooks?\b|\bpencils?\b|\bpens?\b|\bmarkers?\b/.test(c)) return CAT.STATIONERY;

    // H) Cars & motorcycles
    if (/\bautomobiles?\b|\bmotorcycles?\b|\bauto parts\b|\bcar\b|\bvehicles?\b/.test(c)) return CAT.CAR;

    // I) Computers
    if (/\bcomputer\b|\blaptops?\b|\bnetworking\b|\bmini pcs?\b|\bmonitors?\b|\bkeyboards?\b|\bmouse\b|\bmice\b|\bgraphics cards?\b|\bmotherboards?\b|\bstorage devices?\b|\bprinters?\b|\bflash drives?\b|\bhard drives?\b|\bwebcams?\b/.test(c)) return CAT.COMPUTER;

    // J) Beauty & personal care (before kitchen/electronics: "Personal Care Appliances")
    if (/\bbeauty\b|\bhealth\b|\bhair\b|\bmake-?up\b|\bskin ?care\b|\bnails?\b|\bpersonal care\b|\bwigs?\b|\bshav(er|ers|ing)\b|\bmassag(e|er)\b|\bperfumes?\b|\bcosmetics?\b/.test(c)) return CAT.BEAUTY;

    // K) Kitchen
    if (/\bkitchen\b|\bdining\b|\bcookware\b|\bbakeware\b|\bcooking\b|\btableware\b|\bdrinkware\b|\bcutlery\b|\bfood storage\b/.test(c)) return CAT.KITCHEN;

    // L) Consumer electronics
    if (/\bconsumer electronics\b|\bsmart electronics\b|\bportable audio\b|\bearphones?\b|\bheadphones?\b|\bheadsets?\b|\bearbuds?\b|\bspeakers?\b|\bcamera\b|\bphoto\b|\bhome audio\b|\bvideo games?\b|\bhome appliances?\b|\bsecurity (&|and) protection\b|\belectronic components\b|\bsmart home\b|\btv\b|\bprojectors?\b|\bgadgets?\b/.test(c)) return CAT.ELECTRONICS;

    // M) Bathroom, cleaning, storage
    if (/\bbath(room)?\b|\bshower\b|\btoilet\b|\bcleaning\b|\blaundry\b|\bhome storage\b|\borgani[sz](ation|ers?)\b/.test(c)) return CAT.BATH;

    // N) Lighting & decor
    if (/\blights?\b|\blighting\b|\blamps?\b|\bled\b|\bchandeliers?\b|\bhome decor\b|\bdecorations?\b|\bfestive\b|\bparty\b|\bcurtains?\b|\bwall (stickers?|art)\b/.test(c)) return CAT.LIGHTING;

    // O) Tools
    if (/\btools?\b|\bhardware\b|\bhome improvement\b|\bindustry\b|\bmachinery\b|\bwelding\b/.test(c)) return CAT.TOOLS;

    // P) Sports
    if (/\bsports?\b|\boutdoors?\b|\bfitness\b|\bcamping\b|\bcycling\b|\bfishing\b|\bhiking\b|\byoga\b|\bgym\b|\bentertainment\b|\bmusical instruments?\b/.test(c)) return CAT.SPORTS;

    // Q) Toys & kids
    if (/\btoys?\b|\bhobbies\b|\bbaby\b|\bkids?\b|\bmother\b|\bpuzzles?\b|\bdolls?\b|\bstrollers?\b|\bdiapers?\b|\bpregnancy\b/.test(c)) return CAT.TOYS;

    // R) Home & garden
    if (/\bhome (&|and) garden\b|\bhome textile\b|\bgarden\b|\bfurniture\b|\bpet products?\b|\bbeddings?\b/.test(c)) return CAT.HOME;
  }

  // ---- Title fallback (strict whole words) ----
  if (HANDSET_TITLE.test(t) && !ACC_TITLE.test(t)) return CAT.PHONES;
  if (/\b(tablet|ipad)\b/.test(t) && !ACC_TITLE.test(t)) return CAT.PHONES;
  if (/\bphone\b|\biphone\b|\bscreen protector\b|\bmagsafe\b/.test(t) && ACC_TITLE.test(t)) return CAT.PHONE_ACC;
  if (SHOES_RE.test(t) && !SHOE_ACC.test(t)) return CAT.SHOES;
  if (CLOTHES_TITLE.test(t)) {
    const g = genderOf(t);
    if (g) return g;
    if (/\bunisex\b/.test(t)) return CAT.UNISEX;
  }
  if (/\b(backpack|handbag|wallet|suitcase|luggage|purse|crossbody|tote)\b/.test(t)) return CAT.BAGS;
  if (/\b(smart ?watch|wristwatch|watch)\b/.test(t)) return CAT.WATCHES;
  if (/\b(necklace|bracelet|earrings?|jewel(le)?ry|sunglasses)\b/.test(t)) return CAT.FASHION_ACC;
  if (/\b(car|auto|vehicle|motorcycle)\b/.test(t)) return CAT.CAR;
  if (/\b(mouse|keyboard|laptop|motherboard|ssd|monitor|webcam)\b/.test(t)) return CAT.COMPUTER;
  if (/\b(earphones?|headphones?|earbuds?|tws|speaker|camera|projector)\b/.test(t)) return CAT.ELECTRONICS;
  if (/\b(kitchen|cookware|blender|slicer|peeler|grater|spatula|mug)\b/.test(t)) return CAT.KITCHEN;
  if (/\b(lamp|night light|chandelier|led strip)\b/.test(t)) return CAT.LIGHTING;
  if (/\b(hair|trimmer|shaver|clipper|makeup|massager|skin ?care)\b/.test(t)) return CAT.BEAUTY;
  if (/\b(drill|screwdriver|wrench|repair kit)\b/.test(t)) return CAT.TOOLS;
  if (/\b(yoga|fitness|gym|camping|cycling|dumbbell|resistance bands?)\b/.test(t)) return CAT.SPORTS;
  if (/\b(toys?|puzzle|dolls?)\b/.test(t)) return CAT.TOYS;
  if (/\b(bathroom|towel|soap|shower|toilet)\b/.test(t)) return CAT.BATH;
  if (/\b(organizer|storage box|storage bag)\b/.test(t)) return CAT.BAGS;
  return CAT.OTHER;
}

// Phones: allowed in Algeria (checked by the site owner). They are ranked by sales
// and are EXEMPT from the minimum-orders rule, but only the best sellers are kept.
const MIN_ORDERS = 1000;
const PHONE_MAX = 40;
const PHONE_EXCLUDE = /\b(refurbished|renewed|used|second[- ]?hand|pre[- ]?owned)\b/i;

// Find category ids by NAME at run time (ids may differ), with unverified fallbacks.
async function resolveFashionCategories() {
  const wanted = [
    { name: "Women's Clothing", re: /^women'?s clothing$/i, fallback: '100003109', pages: 3 },
    { name: "Men's Clothing", re: /^men'?s clothing$/i, fallback: '100003070', pages: 3 },
    { name: 'Shoes', re: /^shoes$/i, fallback: '322', pages: 3 },
    { name: 'Kids Clothing', re: /\b(boys?|girls?|baby|babies|kids?|children)\b.{0,12}clothing|clothing.{0,12}\b(boys?|girls?|baby|kids?)\b/i, multi: true, fallback: null, pages: 2 },
  ];
  let cats = [];
  try {
    const json = await callAliApi('aliexpress.affiliate.category.get', {});
    cats = json?.aliexpress_affiliate_category_get_response?.resp_result?.result?.categories?.category || [];
  } catch (err) {
    console.warn('category.get failed:', err?.message || err);
  }
  console.log(`category.get returned ${cats.length} categories`);
  const out = [];
  for (const w of wanted) {
    const hits = cats.filter((c) => w.re.test(String(c.category_name || '').replace(/[’`]/g, "'").trim()));
    let ids = hits.map((c) => String(c.category_id));
    if (!w.multi) ids = ids.slice(0, 1);
    else ids = ids.slice(0, 4);
    if (!ids.length && w.fallback) ids = [w.fallback];
    if (!ids.length) { console.warn(`No category id found for ${w.name}`); continue; }
    console.log(`Category "${w.name}" -> ${ids.join(',')}`);
    out.push({ id: ids.join(','), pages: w.pages, name: w.name });
  }
  return out;
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

  TARGET_HOT_CATEGORIES.push(...(await resolveFashionCategories()));

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
      'men sneakers running shoes casual',
      'women dress summer elegant',
      'men t-shirt cotton hoodie',
      'kids clothes baby boys girls set',
      'women sandals slippers shoes',
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
  const phoneCandidates = [];
  const seenPhones = new Set();
  for (const r of raw) {
    const id = String(r.product_id);
    if (!id || uniqueMap.has(id) || seenPhones.has(id)) continue;

    const link = r.promotion_link;
    if (!link || typeof link !== 'string' || !link.startsWith('http') || link.includes('www.aliexpress.com/item/undefined')) {
      continue;
    }

    if (RESTRICTED.test(r.product_title || '')) continue;

    const ordersCount = Number(r.lastest_volume) || 0;
    const category = classify(r.first_level_category_name, r.second_level_category_name, r.product_title);
    r.__category = category;

    if (category === CAT.PHONES) {
      if (PHONE_EXCLUDE.test(r.product_title || '')) continue; // no refurbished / used phones
      seenPhones.add(id);
      phoneCandidates.push(r); // decided below (ranked by sales, no minimum orders)
      continue;
    }

    if (ordersCount < MIN_ORDERS) continue;
    uniqueMap.set(id, r);
  }

  // Phones: keep the best sellers only; those below the minimum are flagged as exempt
  phoneCandidates.sort((x, y) => (Number(y.lastest_volume) || 0) - (Number(x.lastest_volume) || 0));
  for (const r of phoneCandidates.slice(0, PHONE_MAX)) {
    r.__exempt = (Number(r.lastest_volume) || 0) < MIN_ORDERS;
    uniqueMap.set(String(r.product_id), r);
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
      category: r.__category || CAT.OTHER,
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
      minOrdersExempt: Boolean(r.__exempt),
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

  // Diagnostics: category breakdown + sample of unclassified titles
  const counts = {};
  for (const pr of products) counts[pr.category] = (counts[pr.category] || 0) + 1;
  console.log('Category breakdown:', JSON.stringify(counts, null, 2));
  const unclassified = products.filter((pr) => pr.category === CAT.OTHER).slice(0, 15).map((pr) => pr.title);
  if (unclassified.length) console.log('Unclassified (sample):', JSON.stringify(unclassified, null, 2));
  console.log(`Phones kept: ${products.filter((pr) => pr.category === CAT.PHONES).length} (exempt from minimum orders: ${products.filter((pr) => pr.minOrdersExempt).length})`);

  fs.writeFileSync(productsPath, JSON.stringify(outputPayload, null, 2), 'utf8');
  fs.writeFileSync(historyPath, JSON.stringify(nextHistory), 'utf8');

  console.log(`Successfully saved ${products.length} winning products to data/products.json`);
}

main().catch((err) => {
  console.error('Fatal error during sync:', err);
  process.exit(1);
});
