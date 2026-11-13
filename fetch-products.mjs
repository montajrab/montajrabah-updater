// MontajRabah — daily updater
// AliExpress Affiliate API  ->  scoring  ->  Firestore "products"
// Real data only. Missing values are stored as null (never invented).

import crypto from "node:crypto";
import { initializeApp } from "firebase/app";
import { getAuth, signInWithEmailAndPassword } from "firebase/auth";
import {
  getFirestore, collection, doc, getDocs, query, where, limit,
  writeBatch, serverTimestamp, Timestamp,
} from "firebase/firestore";

const {
  ALI_APP_KEY,
  ALI_APP_SECRET,
  ALI_TRACKING_ID,
  FIREBASE_API_KEY,
  FIREBASE_PROJECT_ID,
  FIRESTORE_DATABASE_ID,
  UPDATER_EMAIL,
  UPDATER_PASSWORD,
} = process.env;

for (const [k, v] of Object.entries({
  ALI_APP_KEY, ALI_APP_SECRET, ALI_TRACKING_ID,
  FIREBASE_API_KEY, FIREBASE_PROJECT_ID, UPDATER_EMAIL, UPDATER_PASSWORD,
})) {
  if (!v) { console.error(`Missing secret: ${k}`); process.exit(1); }
}

// The updater signs in as a dedicated Firebase user. Firestore rules allow
// writes to "products" only for that user's UID (no service-account key needed).
const app = initializeApp({
  apiKey: FIREBASE_API_KEY,
  authDomain: `${FIREBASE_PROJECT_ID}.firebaseapp.com`,
  projectId: FIREBASE_PROJECT_ID,
});
await signInWithEmailAndPassword(getAuth(app), UPDATER_EMAIL, UPDATER_PASSWORD);
const db = getFirestore(app, FIRESTORE_DATABASE_ID || "(default)");
console.log("Signed in as updater");

// ---------------------------------------------------------------
// 1) AliExpress API
// ---------------------------------------------------------------
const API_URL = "https://api-sg.aliexpress.com/sync";

function sign(params) {
  const base = Object.keys(params).sort().map((k) => k + params[k]).join("");
  return crypto.createHmac("sha256", ALI_APP_SECRET).update(base).digest("hex").toUpperCase();
}

// AliExpress docs/examples differ on the timestamp format, so we try both.
function chinaTime() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d.toISOString().replace("T", " ").slice(0, 19);
}
const TIMESTAMP_FORMATS = [() => String(Date.now()), chinaTime];
let tsIndex = 0;

async function call(method, extra) {
  let lastJson = null;
  for (let i = tsIndex; i < TIMESTAMP_FORMATS.length; i++) {
    const params = {
      app_key: ALI_APP_KEY,
      timestamp: TIMESTAMP_FORMATS[i](),
      sign_method: "sha256",
      method,
      ...extra,
    };
    params.sign = sign(params);
    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" },
      body: new URLSearchParams(params),
    });
    lastJson = await res.json();
    const msg = JSON.stringify(lastJson).toLowerCase();
    const timeProblem = msg.includes("timestamp") || msg.includes("invalid sign");
    if (lastJson?.error_response && timeProblem && i < TIMESTAMP_FORMATS.length - 1) {
      console.warn(`Timestamp format #${i} rejected, trying next format...`);
      tsIndex = i + 1;
      continue;
    }
    return lastJson;
  }
  return lastJson;
}

async function fetchHotProducts(pages = 4) {
  const all = [];
  for (let page = 1; page <= pages; page++) {
    const json = await call("aliexpress.affiliate.hotproduct.query", {
      page_no: String(page),
      page_size: "50",
      ship_to_country: "DZ",
      target_currency: "USD",
      target_language: "EN",
      tracking_id: ALI_TRACKING_ID,
      sort: "LAST_VOLUME_DESC",
    });
    const list =
      json?.aliexpress_affiliate_hotproduct_query_response?.resp_result?.result?.products?.product;
    if (!list || !list.length) {
      console.error("Unexpected or empty API response (page " + page + "):",
        JSON.stringify(json).slice(0, 1500));
      break;
    }
    all.push(...list);
  }
  return all;
}

// ---------------------------------------------------------------
// 2) Filters and scoring
// ---------------------------------------------------------------
// Items that are banned or need authorization to import into Algeria
// (drones, spy gear, GPS, weapons, lasers, medicines/supplements...).
// This is a safety filter, NOT a legal list: users must verify with customs.
const RESTRICTED =
  /(drone|quadcopter|uav|spy|hidden camera|mini camera|wifi camera|surveillance|listening|wiretap|gps tracker|gps|walkie|jammer|signal blocker|laser pointer|laser pen|stun|taser|pepper spray|knife|dagger|sword|crossbow|slingshot|airsoft|gun|pistol|rifle|ammo|supplement|capsule|pills?|tablet pill|medicine|weight loss|slimming|viagra|vape|e-?cig|cigarette|tobacco|hookah|counterfeit|replica|fake)/i;

// Fragile or tricky to ship (lowers "suitability", does not exclude)
const FRAGILE = /(glass|ceramic|perfume|liquid|oil|spray|lithium|battery|power bank)/i;

const clamp = (x, a = 0, b = 100) => Math.max(a, Math.min(b, x));

function computeScore(p, growth) {
  const reasons = [];

  const ordersPts = clamp((Math.log10(p.orders + 1) / Math.log10(20000)) * 100);
  const demand = growth === null ? ordersPts : 0.6 * ordersPts + 0.4 * clamp(growth * 5);
  reasons.push(p.orders >= 1000 ? "طلب مرتفع" : "طلب متوسط أو منخفض");
  if (growth !== null && growth > 5) reasons.push("الطلب في ازدياد");

  // Margin is only an ESTIMATE from the price range (real shipping is unknown).
  const pr = p.price;
  const profit = pr < 2 ? 30 : pr < 5 ? 70 : pr <= 15 ? 100 : pr <= 30 ? 70 : 40;
  reasons.push(pr >= 5 && pr <= 15 ? "سعر مناسب لهامش ربح جيد" : "تحقق من هامش الربح بالحاسبة");

  const fragile = FRAGILE.test(p.title);
  const suitability = fragile ? 40 : 80;
  if (fragile) reasons.push("قد يكون هشاً أو مقيداً في الشحن/الاستيراد");

  const supplier = p.rating ? clamp(((p.rating - 3.5) / 1.5) * 100) : 40;
  reasons.push(p.rating >= 4.5 ? "تقييم مورد ممتاز" : "تقييم مورد متوسط");

  const score = Math.round(
    (0.30 * demand + 0.25 * profit + 0.15 * suitability + 0.15 * supplier) / 0.85
  );
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

// ---------------------------------------------------------------
// 3) Main
// ---------------------------------------------------------------
const today = new Date().toISOString().slice(0, 10);
const raw = await fetchHotProducts();
console.log(`Fetched ${raw.length} products`);
if (!raw.length) process.exit(1);

// keep only products that have an affiliate link and are not restricted
const items = raw.filter((r) => {
  if (!r.promotion_link) return false;
  if (RESTRICTED.test(r.product_title || "")) return false;
  return true;
});
console.log(`Kept ${items.length} (affiliate link present, restricted items removed)`);
if (!items.length) process.exit(1);

// existing docs (to keep the daily orders history)
const existing = new Map();
(await getDocs(collection(db, "products"))).forEach((d) => existing.set(d.id, d.data()));

for (let i = 0; i < items.length; i += 200) {
  const chunk = items.slice(i, i + 200);
  const batch = writeBatch(db);

  chunk.forEach((r) => {
    const id = String(r.product_id);
    const prev = existing.get(id) || null;
    const p = {
      title: r.product_title,
      imageUrl: r.product_main_image_url,
      productUrl: r.promotion_link,
      category: r.first_level_category_name || r.second_level_category_name || "أخرى",
      price: Number(r.target_sale_price),
      orders: Number(r.lastest_volume) || 0,
      rating: r.evaluate_rate ? parseFloat(r.evaluate_rate) / 20 : null,
    };

    // daily snapshot of orders -> real 7-day growth after a few days
    const history = (prev?.history || []).filter((h) => h.d !== today);
    history.push({ d: today, o: p.orders });
    const trimmed = history.slice(-8);
    const first = trimmed[0];
    const growth =
      trimmed.length > 1 && first.o > 0 ? ((p.orders - first.o) / first.o) * 100 : null;

    batch.set(
      doc(db, "products", id),
      {
        ...p,
        orders7dGrowth: growth === null ? null : Math.round(growth * 10) / 10,
        shippingToDZ: null,   // not provided by the API -> user enters it in the calculator
        deliveryDays: null,
        reviewsCount: null,
        history: trimmed,
        ...computeScore(p, growth),
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
  });
  await batch.commit();
}

// remove stale products (not refreshed for 10 days) so old data never lingers
const cutoff = Timestamp.fromMillis(Date.now() - 10 * 24 * 3600 * 1000);
const stale = await getDocs(
  query(collection(db, "products"), where("updatedAt", "<", cutoff), limit(400))
);
if (!stale.empty) {
  const batch = writeBatch(db);
  stale.forEach((d) => batch.delete(d.ref));
  await batch.commit();
  console.log(`Deleted ${stale.size} stale products`);
}

console.log("Done");
process.exit(0);
