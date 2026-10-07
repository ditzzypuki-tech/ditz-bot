'use strict';
/* DITZ MARKET — backend (tanpa dependensi, Node >= 18)
   Jalankan: node server.js   |   Data tersimpan di data/db.json */
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto'), zlib = require('zlib');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';           // di VPS diset 127.0.0.1 (hanya Nginx yang boleh akses)
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC = path.join(__dirname, 'public');
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true';   // true jika di belakang HTTPS
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';       // true jika di belakang proxy (Nginx, Cloudflare, dll.)
const FEE = 1500, PAY_MS = 15 * 60000, USER_SESSION_MS = 7 * 864e5, ADMIN_SESSION_MS = 8 * 36e5;
const METHODS = ['QRIS', 'DANA', 'GoPay'];
const ST = { UNPAID: 'Menunggu Pembayaran', VERIFY: 'Menunggu Verifikasi', PAID: 'Dibayar - Diproses', DONE: 'Berhasil', EXPIRED: 'Kedaluwarsa', CANCELLED: 'Dibatalkan' };
const PRODUCTS = {
  'Mobile Legends': [15000, 30000, 50000, 100000, 200000, 500000], 'Free Fire': [10000, 20000, 50000, 100000, 200000, 500000],
  'Steam Wallet': [12000, 45000, 60000, 90000, 120000, 250000], 'Roblox': [15000, 30000, 60000, 120000, 240000, 500000],
  'Magic Chess: Go Go': [15000, 30000, 50000, 100000, 200000, 500000], 'Valorant': [15000, 35000, 70000, 145000, 290000, 500000],
  'Maple Haven City Rush': [15000, 30000, 50000, 100000, 200000, 500000], 'AMAR - CHAT & REAL FRIEND': [15000, 30000, 50000, 100000, 200000, 500000],
  'Stranger Than Heaven': [15000, 30000, 50000, 100000, 200000, 500000], 'Persona 4 Revival': [15000, 30000, 50000, 100000, 200000, 500000],
  'PUBG Mobile': [16000, 32000, 60000, 120000, 240000, 500000], 'Google Play': [15000, 25000, 50000, 100000, 200000, 500000],
  'PlayStation': [50000, 100000, 200000, 300000, 500000, 1000000]
};

/* ---------- Integrasi pihak ketiga (semuanya opsional, aktif bila variabel lingkungannya diisi) ----------
   Midtrans  : QRIS & GoPay otomatis     -> MIDTRANS_SERVER_KEY (+ MIDTRANS_ENV=production)
   Xendit    : DANA otomatis             -> XENDIT_SECRET_KEY, XENDIT_CALLBACK_TOKEN, SITE_URL (https://domainmu.com)
   Digiflazz : top up game otomatis      -> DIGIFLAZZ_USERNAME, DIGIFLAZZ_KEY, DIGIFLAZZ_WEBHOOK_SECRET
   Telegram  : notifikasi ke admin       -> TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID                        */
const MT_KEY = process.env.MIDTRANS_SERVER_KEY || '';
const MT_BASE = process.env.MIDTRANS_BASE_URL || (process.env.MIDTRANS_ENV === 'production' ? 'https://api.midtrans.com' : 'https://api.sandbox.midtrans.com');
const SITE_URL = (process.env.SITE_URL || '').replace(/\/$/, '');
const XD_KEY = process.env.XENDIT_SECRET_KEY || '', XD_TOKEN = process.env.XENDIT_CALLBACK_TOKEN || '', XD_BASE = process.env.XENDIT_BASE_URL || 'https://api.xendit.co';
const XD_ON = !!(XD_KEY && XD_TOKEN && SITE_URL);
const DF_USER = process.env.DIGIFLAZZ_USERNAME || '', DF_KEY = process.env.DIGIFLAZZ_KEY || '', DF_SECRET = process.env.DIGIFLAZZ_WEBHOOK_SECRET || '', DF_BASE = process.env.DIGIFLAZZ_BASE_URL || 'https://api.digiflazz.com';
const DF_ON = !!(DF_USER && DF_KEY);
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '', TG_CHAT = process.env.TELEGRAM_CHAT_ID || '', TG_BASE = process.env.TELEGRAM_BASE_URL || 'https://api.telegram.org';
const AUTO_METHODS = [].concat(MT_KEY ? ['QRIS', 'GoPay'] : [], XD_ON ? ['DANA'] : []);
const rp = n => 'Rp' + Number(n).toLocaleString('id-ID');
const md5 = x => crypto.createHash('md5').update(x).digest('hex');
const safeEq = (a, b) => { a = Buffer.from(String(a)); b = Buffer.from(String(b)); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const basic = k => 'Basic ' + Buffer.from(k + ':').toString('base64');

async function tg(text) {   // notifikasi ke admin; gagal tidak boleh mengganggu alur pesanan
  if (!TG_TOKEN || !TG_CHAT) return;
  try { await fetch(TG_BASE + '/bot' + TG_TOKEN + '/sendMessage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: TG_CHAT, text }), signal: AbortSignal.timeout(10000) }); }
  catch (e) { console.error('Telegram gagal:', e.message); }
}
async function jfetch(url, opt) {
  const r = await fetch(url, Object.assign({ signal: AbortSignal.timeout(15000) }, opt));
  let d = {}; try { d = await r.json(); } catch (e) {}
  return d;
}
const mt = (method, p, payload) => jfetch(MT_BASE + p, { method, body: payload ? JSON.stringify(payload) : undefined, headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: basic(MT_KEY) } });
const xd = (method, p, payload) => jfetch(XD_BASE + p, { method, body: payload ? JSON.stringify(payload) : undefined, headers: { 'Content-Type': 'application/json', Authorization: basic(XD_KEY), 'Idempotency-key': payload ? payload.reference_id : '' } });
const providerOf = m => m === 'DANA' ? 'xendit' : 'midtrans';

async function createCharge(o) {
  if (o.method === 'DANA') {
    const d = await xd('POST', '/ewallets/charges', { reference_id: o.id, currency: 'IDR', amount: o.amount, checkout_method: 'ONE_TIME_PAYMENT', channel_code: 'ID_DANA', channel_properties: { success_redirect_url: SITE_URL + '/', failure_redirect_url: SITE_URL + '/' } });
    if (!d.id) throw new Error('Xendit: ' + (d.message || d.error_code || 'gagal'));
    const a = d.actions || d, ok = u => /^https:\/\//.test(u || '') ? u : '';
    const desktop = ok(a.desktop_web_checkout_url), mobile = ok(a.mobile_web_checkout_url) || ok(a.mobile_deeplink_checkout_url);
    if (!desktop && !mobile) throw new Error('Xendit: URL pembayaran tidak ada');
    return { provider: 'xendit', txId: d.id, qrUrl: '', deeplink: mobile || desktop, checkoutUrl: desktop || mobile };
  }
  const common = {
    transaction_details: { order_id: o.id, gross_amount: o.amount },
    item_details: [{ id: 'item', price: o.price, quantity: 1, name: (o.product + ' ' + o.item).slice(0, 50) }, { id: 'fee', price: o.fee, quantity: 1, name: 'Biaya layanan' }],
    custom_expiry: { expiry_duration: PAY_MS / 60000, unit: 'minute' }
  };
  const payload = o.method === 'QRIS' ? Object.assign({ payment_type: 'qris', qris: { acquirer: 'gopay' } }, common) : Object.assign({ payment_type: 'gopay', gopay: { enable_callback: false } }, common);
  const d = await mt('POST', '/v2/charge', payload);
  if (String(d.status_code) !== '201') throw new Error('Midtrans: ' + (d.status_message || d.status_code));
  const act = n => ((d.actions || []).find(a => a.name === n) || {}).url;
  const qrUrl = act('generate-qr-code-v2') || act('generate-qr-code') || d.url, dl = act('deeplink-redirect') || '';
  if (!qrUrl) throw new Error('Midtrans: URL QR tidak ada');
  return { provider: 'midtrans', txId: d.transaction_id, qrUrl, deeplink: /^(https:\/\/|gojek:\/\/)/.test(dl) ? dl : '' };
}
function mtSigOk(n) {
  const exp = crypto.createHash('sha512').update(String(n.order_id) + String(n.status_code) + String(n.gross_amount) + MT_KEY).digest('hex');
  return safeEq(exp, n.signature_key || '');
}
/* Pembayaran terverifikasi gateway -> "Dibayar - Diproses" -> (bila dipetakan) kirim top up ke supplier */
function applyPaid(o, gross) {
  if (gross !== o.amount) { o.note = 'Nominal gateway tidak cocok: ' + gross; save(); return; }
  if (![ST.UNPAID, ST.VERIFY, ST.EXPIRED, ST.CANCELLED].includes(o.status)) return;
  if (o.status === ST.EXPIRED || o.status === ST.CANCELLED) o.note = 'Dibayar setelah ' + o.status.toLowerCase();
  o.status = ST.PAID; o.paidAt = Date.now(); save();
  tg('✅ Pembayaran masuk ' + o.id + '\n' + o.product + ' · ' + o.item + '\nID: ' + o.player + '\nTotal ' + rp(o.amount) + (o.note ? '\n⚠ ' + o.note : ''));
  fulfill(o).catch(e => console.error('Fulfill gagal:', e.message));
}
/* Cek status langsung ke gateway (bukan percaya isi webhook), lalu perbarui pesanan. Aman dipanggil berulang. */
async function syncGateway(o) {
  if (o.gw.provider === 'xendit') {
    const d = await xd('GET', '/ewallets/charges/' + encodeURIComponent(o.gw.txId));
    if (d.reference_id !== o.id) return;
    if (d.status === 'SUCCEEDED') applyPaid(o, Number(d.charge_amount));
    else if ((d.status === 'FAILED' || d.status === 'VOIDED') && o.status === ST.UNPAID) { o.status = ST.EXPIRED; save(); }
    return;
  }
  const d = await mt('GET', '/v2/' + o.id + '/status');
  if (d.order_id !== o.id) return;
  const ts = d.transaction_status;
  if (ts === 'settlement' || ts === 'capture') applyPaid(o, Number(d.gross_amount));
  else if (['expire', 'cancel', 'deny'].includes(ts) && o.status === ST.UNPAID) { o.status = ts === 'expire' ? ST.EXPIRED : ST.CANCELLED; save(); }
}
async function midtransNotify(req, res) {
  if (!MT_KEY) return fail(res, 404, 'Tidak aktif.');
  let n; try { n = await body(req); } catch (e) { return fail(res, 400, 'Data tidak valid.'); }
  if (!mtSigOk(n)) return fail(res, 403, 'Signature tidak valid.');
  const o = db.orders.find(x => x.id === n.order_id && x.gw && x.gw.provider !== 'xendit');
  if (o) await syncGateway(o);      // bila gagal -> 500, Midtrans akan mengirim ulang
  return send(res, 200, { ok: true });
}
async function xenditNotify(req, res) {
  if (!XD_ON) return fail(res, 404, 'Tidak aktif.');
  if (!safeEq(req.headers['x-callback-token'] || '', XD_TOKEN)) return fail(res, 403, 'Token tidak valid.');
  let n; try { n = await body(req); } catch (e) { return fail(res, 400, 'Data tidak valid.'); }
  const ref = (n.data && n.data.reference_id) || n.reference_id;
  const o = db.orders.find(x => x.id === ref && x.gw && x.gw.provider === 'xendit');
  if (o) await syncGateway(o);
  return send(res, 200, { ok: true });
}

/* ---------- Top up otomatis lewat Digiflazz ----------
   Hanya untuk paket yang kode SKU-nya diisi admin (Admin > Produk). Selain itu tetap manual.
   ref_id = ID pesanan, jadi mengirim ulang tidak membuat transaksi ganda (sesuai dokumentasi Digiflazz). */
const skuOf = o => { const a = db.settings.skus[o.product]; return a && a[o.pkgIdx] ? String(a[o.pkgIdx]) : ''; };
async function fulfill(o) {
  if (!DF_ON || o.status !== ST.PAID || o.sup) return;
  const sku = skuOf(o); if (!sku) return;
  o.sup = { sku, at: Date.now(), state: 'sending', tries: 0 }; save();
  await dfCall(o);
}
async function dfCall(o) {
  o.sup.tries++;
  let d = {};
  try {
    const j = await jfetch(DF_BASE + '/v1/transaction', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: DF_USER, buyer_sku_code: o.sup.sku, customer_no: o.zone ? o.pid + o.zone : o.pid, ref_id: o.id, sign: md5(DF_USER + DF_KEY + o.id) }) });
    d = j.data || {};
  } catch (e) { d = { status: '', message: e.message }; }
  applySupplier(o, d);
}
function applySupplier(o, d) {
  if (!o.sup || o.sup.state === 'done') return;
  const st = String(d.status || '');
  if (st === 'Sukses') {
    o.sup.state = 'done'; o.sup.sn = String(d.sn || '').slice(0, 200); o.status = ST.DONE; o.doneAt = Date.now(); o.note = '';
    tg('🎮 Top up otomatis BERHASIL ' + o.id + '\n' + o.product + ' · ' + o.item + '\nID: ' + o.player);
  } else if (st === 'Gagal') {
    o.sup.state = 'failed'; o.note = 'Supplier gagal: ' + String(d.message || d.rc || '').slice(0, 120);
    tg('❌ Top up otomatis GAGAL ' + o.id + '\n' + o.product + ' · ' + o.item + '\nID: ' + o.player + '\n' + o.note + '\nProses manual / refund pembeli.');
  } else if (st === 'Pending') o.sup.state = 'pending';
  else {
    o.sup.state = 'error'; o.note = 'Supplier belum merespons benar: ' + String(d.message || 'tanpa respons').slice(0, 120);
    if (o.sup.tries === 1 || o.sup.tries >= 20) tg('⚠ Top up otomatis bermasalah ' + o.id + ': ' + o.note + (o.sup.tries >= 20 ? '\nBerhenti mencoba, proses manual.' : ''));
  }
  save();
}
async function supSweep() {     // cek ulang pesanan yang masih pending/error (kirim ulang ref_id yang sama)
  if (!DF_ON) return;
  for (const o of db.orders.filter(x => x.sup && ['sending', 'pending', 'error'].includes(x.sup.state) && x.sup.tries < 20 && x.status === ST.PAID && Date.now() - x.sup.at > 20000).slice(0, 10)) {
    o.sup.at = Date.now(); await dfCall(o);
  }
}
setInterval(() => supSweep().catch(e => console.error('supSweep:', e.message)), 30000).unref();
async function digiflazzNotify(req, res) {
  if (!DF_ON || !DF_SECRET) return fail(res, 404, 'Tidak aktif.');
  let raw; try { raw = await body(req, 20000, true); } catch (e) { return fail(res, 400, 'Data tidak valid.'); }
  const sig = 'sha1=' + crypto.createHmac('sha1', DF_SECRET).update(raw).digest('hex');
  if (!safeEq(req.headers['x-hub-signature'] || '', sig)) return fail(res, 403, 'Signature tidak valid.');
  let d = {}; try { d = (JSON.parse(raw).data) || {}; } catch (e) {}
  const o = db.orders.find(x => x.id === d.ref_id && x.sup);
  if (o) applySupplier(o, d);
  return send(res, 200, { ok: true });
}

const pub = o => { const { gw, lastSync, sup, ...rest } = o; if (gw) { rest.deeplink = gw.deeplink || ''; rest.checkoutUrl = gw.checkoutUrl || ''; } rest.sn = (sup && sup.sn) || ''; return rest; };   // buang data internal

/* ---------- Kode promo ---------- */
function promoOf(code, user, price) {
  const c = String(code || '').trim().toUpperCase(); if (!c) return { discount: 0 };
  const p = db.settings.promos[c];
  if (!p || !p.active) return { err: 'Kode promo tidak valid.' };
  if (p.expires && Date.now() > p.expires) return { err: 'Kode promo sudah kedaluwarsa.' };
  if (p.minPrice && price < p.minPrice) return { err: 'Kode ini berlaku untuk paket minimal ' + rp(p.minPrice) + '.' };
  const live = db.orders.filter(o => o.promo === c && ![ST.EXPIRED, ST.CANCELLED].includes(o.status));
  if (p.maxUses && live.length >= p.maxUses) return { err: 'Kuota kode promo sudah habis.' };
  if (live.some(o => o.user === user)) return { err: 'Kode promo ini sudah kamu pakai.' };
  let d = p.type === 'percent' ? Math.floor(price * p.value / 100) : p.value;
  if (p.maxDiscount && d > p.maxDiscount) d = p.maxDiscount;
  d = Math.min(d, price - 1000);
  if (d <= 0) return { err: 'Kode promo tidak berlaku untuk paket ini.' };
  return { discount: d, code: c };
}
const PROOF_DIR = path.join(DATA_DIR, 'proofs');
const rmProof = id => { try { fs.unlinkSync(path.join(PROOF_DIR, id + '.jpg')); } catch (e) {} };

/* Aturan input akun per game (server yang menentukan; dikirim ke klien lewat /api/catalog) */
const ML_FIELD = { label: 'User ID', ph: 'Contoh: 12345678', zone: true, re: /^\d{5,12}$/, err: 'User ID berupa 5–12 angka.' };
const VOUCHER_FIELD = { label: 'Email / username penerima', ph: 'Email atau username akunmu', needWa: true };
const FIELDS = {
  'Mobile Legends': ML_FIELD, 'Magic Chess: Go Go': ML_FIELD,
  'Free Fire': { label: 'ID Player', ph: 'Contoh: 123456789', re: /^\d{6,14}$/, err: 'ID Free Fire berupa angka (6–14 digit).' },
  'PUBG Mobile': { label: 'ID Karakter', ph: 'Contoh: 5123456789', re: /^\d{6,14}$/, err: 'ID PUBG Mobile berupa angka (6–14 digit).' },
  'Valorant': { label: 'Riot ID', ph: 'Nama#TAG', re: /^.{3,16}#[A-Za-z0-9]{3,5}$/, err: 'Format Riot ID: Nama#TAG.' },
  'Roblox': { label: 'Username Roblox', ph: 'Username (bukan display name)', re: /^[A-Za-z0-9_]{3,20}$/, err: 'Username Roblox 3–20 karakter (huruf, angka, _).' },
  'Steam Wallet': VOUCHER_FIELD, 'Google Play': VOUCHER_FIELD, 'PlayStation': VOUCHER_FIELD
};
const FIELDS_PUBLIC = Object.fromEntries(Object.entries(FIELDS).map(([n, f]) => [n, { label: f.label, ph: f.ph, zone: !!f.zone, needWa: !!f.needWa, re: f.re ? f.re.source : undefined, err: f.err }]));

/* ---------- database (file JSON, tulis atomik) ---------- */
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, 'db.json');
let db = { users: {}, orders: [], sessions: {}, settings: { products: {}, paymentDisabled: false } };
if (fs.existsSync(DB_FILE)) {
  try { db = Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))); }
  catch (e) {   // file ada tapi rusak: JANGAN ditimpa, selamatkan dulu lalu berhenti
    const bad = DB_FILE + '.rusak-' + Date.now(); fs.copyFileSync(DB_FILE, bad);
    console.error('db.json rusak! Salinan disimpan di ' + bad + '. Perbaiki atau pulihkan dari folder backups/, lalu jalankan ulang.'); process.exit(1);
  }
}
db.settings.promos = db.settings.promos || {}; db.settings.skus = db.settings.skus || {}; db.settings.products = db.settings.products || {};
const BK_DIR = path.join(DATA_DIR, 'backups');
function backup() {   // salinan harian, simpan 14 hari terakhir
  try {
    fs.mkdirSync(BK_DIR, { recursive: true });
    const f = path.join(BK_DIR, 'db-' + new Date().toISOString().slice(0, 10) + '.json');
    if (!fs.existsSync(f) && fs.existsSync(DB_FILE)) fs.copyFileSync(DB_FILE, f);
    fs.readdirSync(BK_DIR).filter(x => /^db-.*\.json$/.test(x)).sort().slice(0, -14).forEach(x => fs.unlinkSync(path.join(BK_DIR, x)));
  } catch (e) { console.error('Backup gagal:', e.message); }
}
backup(); setInterval(backup, 6 * 3600000).unref();
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db)); fs.renameSync(tmp, DB_FILE);
  }, 150);
}
process.on('SIGINT', () => { try { fs.writeFileSync(DB_FILE, JSON.stringify(db)); } catch (e) {} process.exit(0); });
process.on('SIGTERM', () => process.emit('SIGINT'));

/* ---------- keamanan ---------- */
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const scrypt = (pw, salt) => new Promise((res, rej) => crypto.scrypt(pw, salt, 64, (e, k) => e ? rej(e) : res(k.toString('hex'))));
async function hashPw(pw) { const salt = crypto.randomBytes(16).toString('hex'); return salt + ':' + await scrypt(pw, salt); }
async function checkPw(pw, stored) {
  const [salt, h] = String(stored).split(':'); if (!salt || !h) return false;
  const a = Buffer.from(await scrypt(pw, salt), 'hex'), b = Buffer.from(h, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const DUMMY = 'a'.repeat(32) + ':' + 'b'.repeat(128);
const hits = new Map();
function limited(key, max, ms) {
  const n = Date.now(), r = hits.get(key) || { c: 0, t: n + ms };
  if (n > r.t) { r.c = 0; r.t = n + ms; }
  r.c++; hits.set(key, r); return r.c > max;
}
setInterval(() => { const n = Date.now(); for (const [k, r] of hits) if (n > r.t) hits.delete(k); for (const [k, s] of Object.entries(db.sessions)) if (n > s.exp) delete db.sessions[k]; }, 600000).unref();

const ADMIN_NAME = (process.env.ADMIN_USER || 'adit').toLowerCase();
const hasUser = u => Object.prototype.hasOwnProperty.call(db.users, u);   // jangan baca properti bawaan Object (constructor, __proto__, dst.)
const RESERVED = new Set(['admin', 'administrator', 'root', 'system', 'owner', 'ditz', 'ditzmarket', 'support', 'cs', 'constructor', 'prototype']);

async function seedAdmin() {
  if (Object.values(db.users).some(u => u.role === 'admin')) return;
  const name = ADMIN_NAME;
  const alpha = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const pw = process.env.ADMIN_PASS || Array.from(crypto.randomBytes(14), b => alpha[b % alpha.length]).join('');
  db.users[name] = { hash: await hashPw(pw), role: 'admin', created: Date.now() }; save();
  console.log('\n==============================================\n AKUN ADMIN DIBUAT (tampil sekali saja)\n username : ' + name + '\n password : ' + pw + '\n Segera ganti di Admin Panel > Pengaturan.\n==============================================\n');
}

/* ---------- helper HTTP ---------- */
function ipOf(req) { return (TRUST_PROXY && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '?'; }
function send(res, code, obj, headers) { const b = JSON.stringify(obj); res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, headers)); res.end(b); }
const fail = (res, code, msg) => send(res, code, { error: msg });
function body(req, max = 20000, raw = false) {
  return new Promise((res, rej) => {
    let d = ''; req.on('data', c => { d += c; if (d.length > max) { rej(new Error('big')); req.destroy(); } });
    req.on('end', () => { try { res(raw ? d : d ? JSON.parse(d) : {}); } catch (e) { rej(new Error('json')); } });
  });
}
function cookies(req) { const o = {}; String(req.headers.cookie || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); }); return o; }
function sessionOf(req) {
  const t = cookies(req).sid; if (!t) return null;
  const s = db.sessions[sha(t)]; if (!s || Date.now() > s.exp || !db.users[s.user]) return null;
  return { user: s.user, role: db.users[s.user].role, key: sha(t) };
}
function startSession(res, user) {
  const t = crypto.randomBytes(32).toString('hex'), ms = db.users[user].role === 'admin' ? ADMIN_SESSION_MS : USER_SESSION_MS;
  db.sessions[sha(t)] = { user, exp: Date.now() + ms }; save();
  return { 'Set-Cookie': `sid=${t}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${ms / 1000}${COOKIE_SECURE ? '; Secure' : ''}` };
}
const clearCookie = () => ({ 'Set-Cookie': `sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${COOKIE_SECURE ? '; Secure' : ''}` });
const me = s => ({ user: s.user, admin: s.role === 'admin', serverTime: Date.now() });

/* ---------- logika bisnis ---------- */
function sweep() { const n = Date.now(); let ch = false; db.orders.forEach(o => { if (o.status === ST.UNPAID && n > o.expiresAt) { o.status = ST.EXPIRED; ch = true; } }); if (ch) save(); }
function adminSettings() { return Object.assign(catalog(), { skus: db.settings.skus, integrations: { midtrans: !!MT_KEY, xendit: XD_ON, digiflazz: DF_ON, digiflazzWebhook: !!DF_SECRET, telegram: !!(TG_TOKEN && TG_CHAT) } }); }
function catalog() { return { serverTime: Date.now(), paymentDisabled: !!db.settings.paymentDisabled, products: db.settings.products, fields: FIELDS_PUBLIC, autoMethods: AUTO_METHODS }; }
const validPrices = p => Array.isArray(p) && p.length === 6 && p.every(v => Number.isInteger(v) && v >= 1000 && v <= 10000000);

async function api(req, res, url) {
  const route = req.method + ' ' + url.pathname;
  if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'ditz') return fail(res, 403, 'Permintaan tidak valid.');
  let b = {}; if (req.method !== 'GET') { try { b = await body(req, /\/proof$/.test(url.pathname) ? 450000 : 20000); } catch (e) { return fail(res, 400, 'Data tidak valid.'); } }
  const ip = ipOf(req), s = sessionOf(req);

  if (route === 'GET /api/catalog') return send(res, 200, catalog());
  if (route === 'GET /api/me') return s ? send(res, 200, me(s)) : send(res, 200, { user: null, admin: false, serverTime: Date.now() });

  if (route === 'POST /api/register') {
    if (limited('reg|' + ip, 20, 3600000)) return fail(res, 429, 'Terlalu banyak pendaftaran. Coba lagi nanti.');
    const u = String(b.username || '').trim().toLowerCase(), p = String(b.password || '');
    if (!/^[a-z0-9_]{3,20}$/.test(u) || u.startsWith('__')) return fail(res, 400, 'Username 3–20 karakter: huruf kecil, angka, atau _.');
    if (p.length < 8 || p.length > 100) return fail(res, 400, 'Password minimal 8 karakter.');
    if (RESERVED.has(u) || u === ADMIN_NAME) return fail(res, 409, 'Username tidak tersedia, pilih yang lain.');
    if (hasUser(u)) return fail(res, 409, 'Username sudah dipakai.');
    const hash = await hashPw(p);
    if (hasUser(u)) return fail(res, 409, 'Username sudah dipakai.');   // cek ulang: dua pendaftaran bersamaan tidak boleh saling menimpa
    db.users[u] = { hash, role: 'user', created: Date.now() }; save();
    return send(res, 200, me({ user: u, role: 'user' }), startSession(res, u));
  }
  if (route === 'POST /api/login') {
    const u = String(b.username || '').trim().toLowerCase(), p = String(b.password || '');
    if (limited('login|' + ip + '|' + u, 8, 600000)) return fail(res, 429, 'Terlalu banyak percobaan. Coba lagi dalam 10 menit.');
    const rec = hasUser(u) ? db.users[u] : null, ok = await checkPw(p, rec ? rec.hash : DUMMY);
    if (!rec || !ok) return fail(res, 401, 'Username atau password salah.');
    return send(res, 200, me({ user: u, role: rec.role }), startSession(res, u));
  }
  if (route === 'POST /api/reset-password') {
    const u = String(b.username || '').trim().toLowerCase(), code = String(b.code || '').trim().toUpperCase(), p = String(b.password || '');
    if (limited('rst|' + ip + '|' + u, 8, 600000)) return fail(res, 429, 'Terlalu banyak percobaan. Coba lagi dalam 10 menit.');
    const rec = hasUser(u) ? db.users[u] : null;
    if (!rec || rec.role === 'admin' || !rec.reset || Date.now() > rec.reset.exp || !safeEq(sha(code), rec.reset.h)) return fail(res, 400, 'Kode reset salah atau sudah kedaluwarsa.');
    if (p.length < 8 || p.length > 100) return fail(res, 400, 'Password baru minimal 8 karakter.');
    rec.hash = await hashPw(p); delete rec.reset;
    for (const [k, v] of Object.entries(db.sessions)) if (v.user === u) delete db.sessions[k];
    save(); return send(res, 200, { ok: true });
  }
  if (route === 'POST /api/logout') { if (s) { delete db.sessions[s.key]; save(); } return send(res, 200, { ok: true }, clearCookie()); }

  if (!s) return fail(res, 401, 'Silakan login terlebih dahulu.');

  /* ---- pembeli ---- */
  if (route === 'GET /api/orders') {
    const pend = db.orders.filter(o => o.user === s.user && o.gw && o.status === ST.UNPAID && Date.now() - (o.lastSync || 0) > 3000).slice(0, 5);
    await Promise.all(pend.map(o => { o.lastSync = Date.now(); return syncGateway(o).catch(e => console.error('Sinkron gagal:', e.message)); }));
    sweep(); return send(res, 200, { serverTime: Date.now(), orders: db.orders.filter(o => o.user === s.user).sort((a, c) => c.createdAt - a.createdAt).slice(0, 100).map(pub) });
  }
  if (route === 'POST /api/promo/check') {
    const base = PRODUCTS[b.product]; if (!base) return fail(res, 400, 'Produk tidak ditemukan.');
    const ov = db.settings.products[b.product] || {}, prices = validPrices(ov.prices) ? ov.prices : base, price = prices[Number(b.pkg)];
    if (!price) return fail(res, 400, 'Paket tidak valid.');
    if (limited('promo|' + s.user, 40, 600000)) return fail(res, 429, 'Terlalu banyak percobaan. Coba lagi nanti.');
    const pr = promoOf(b.code, s.user, price); if (pr.err) return fail(res, 400, pr.err);
    return send(res, 200, { code: pr.code || '', discount: pr.discount });
  }
  if (route === 'POST /api/orders') {
    if (db.settings.paymentDisabled) return fail(res, 403, 'Pembayaran sedang dinonaktifkan oleh admin.');
    const base = PRODUCTS[b.product]; if (!base) return fail(res, 400, 'Produk tidak ditemukan.');
    const ov = db.settings.products[b.product] || {};
    if (ov.disabled) return fail(res, 403, 'Produk sedang tidak tersedia.');
    const prices = validPrices(ov.prices) ? ov.prices : base, price = prices[Number(b.pkg)];
    const player = String(b.player || '').trim().slice(0, 60), wa = String(b.whatsapp || '').replace(/[\s-]/g, '');
    if (!price) return fail(res, 400, 'Paket tidak valid.');
    const fd = FIELDS[b.product] || {};
    if (!player) return fail(res, 400, (fd.label || 'ID Player') + ' wajib diisi.');
    if (fd.re && !fd.re.test(player)) return fail(res, 400, fd.err || 'Format ID tidak valid.');
    let playerFull = player;
    if (fd.zone) {
      const z = String(b.zone || '').trim();
      if (!/^\d{3,6}$/.test(z)) return fail(res, 400, 'Zone ID wajib diisi (3–6 angka).');
      playerFull = player + ' (' + z + ')';
    }
    if (fd.needWa && !wa) return fail(res, 400, 'Nomor WhatsApp wajib diisi untuk produk voucher.');
    if (b.agree !== true) return fail(res, 400, 'Setujui Syarat & Ketentuan terlebih dahulu.');
    const pr = promoOf(b.promo, s.user, price); if (pr.err) return fail(res, 400, pr.err);
    const discount = pr.discount || 0, pay = price - discount;
    if (wa && !/^(\+?62|0)8\d{7,12}$/.test(wa)) return fail(res, 400, 'Nomor WhatsApp tidak valid.');
    if (!METHODS.includes(b.method)) return fail(res, 400, 'Metode pembayaran tidak valid.');
    sweep();
    if (db.orders.filter(o => o.user === s.user && o.status === ST.UNPAID).length >= 5) return fail(res, 429, 'Selesaikan atau batalkan pesanan yang belum dibayar dulu.');
    if (limited('ord|' + s.user, 30, 3600000)) return fail(res, 429, 'Terlalu banyak pesanan. Coba lagi nanti.');
    const open = new Set(db.orders.filter(o => o.status === ST.UNPAID || o.status === ST.VERIFY).map(o => o.amount));
    const auto = AUTO_METHODS.includes(b.method);
    let unique = 0, amount = auto ? pay + FEE : 0;
    if (!auto) for (let i = 0; i < 40; i++) { unique = 10 + crypto.randomInt(90); amount = pay + FEE + unique; if (!open.has(amount)) break; }
    const now = Date.now();
    const order = { id: 'DM' + crypto.randomBytes(5).toString('hex').toUpperCase(), user: s.user, product: b.product, item: String(b.item || '').slice(0, 60), player: playerFull, pid: player, zone: fd.zone ? String(b.zone).trim() : '', pkgIdx: Number(b.pkg), whatsapp: wa, price: pay, listPrice: price, discount, promo: discount ? pr.code : '', fee: FEE, uniqueCode: unique, amount, method: b.method, status: ST.UNPAID, date: new Date(now).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }), createdAt: now, expiresAt: now + PAY_MS };
    if (auto) {
      try { order.gw = await createCharge(order); order.auto = true; }
      catch (e) { console.error('Charge gagal:', e.message); return fail(res, 502, 'Pembayaran otomatis sedang bermasalah. Coba lagi sebentar atau pilih metode lain.'); }
    }
    db.orders.push(order); save();
    return send(res, 200, { serverTime: now, order: pub(order) });
  }
  const pm = url.pathname.match(/^\/api\/orders\/([A-Z0-9]+)\/proof$/);
  if (pm && req.method === 'POST') {
    const o = db.orders.find(x => x.id === pm[1] && x.user === s.user);
    if (!o) return fail(res, 404, 'Pesanan tidak ditemukan.');
    if (o.gw) return fail(res, 409, 'Pembayaran ini diverifikasi otomatis, tidak perlu bukti.');
    if (o.status !== ST.UNPAID && o.status !== ST.VERIFY) return fail(res, 409, 'Bukti tidak bisa diunggah untuk status ini.');
    if (limited('proof|' + s.user, 20, 3600000)) return fail(res, 429, 'Terlalu banyak unggahan. Coba lagi nanti.');
    const m64 = /^data:image\/jpeg;base64,([A-Za-z0-9+\/=]+)$/.exec(String(b.image || ''));
    const buf = m64 ? Buffer.from(m64[1], 'base64') : null;
    if (!buf || buf.length < 500 || buf.length > 300 * 1024 || buf[0] !== 0xFF || buf[1] !== 0xD8 || buf[2] !== 0xFF) return fail(res, 400, 'Gambar tidak valid (JPEG, maks 300 KB).');
    fs.mkdirSync(PROOF_DIR, { recursive: true }); fs.writeFileSync(path.join(PROOF_DIR, o.id + '.jpg'), buf);
    o.proof = true; save();
    tg('🧾 Bukti bayar masuk ' + o.id + '\n' + o.product + ' · ' + o.item + ' · ' + rp(o.amount) + '\nBuka Admin > Pesanan untuk melihat.');
    return send(res, 200, { serverTime: Date.now(), order: pub(o) });
  }
  const qm = url.pathname.match(/^\/api\/orders\/([A-Z0-9]+)\/qr$/);
  if (qm && req.method === 'GET') {     // gambar QR dari gateway disajikan lewat server sendiri (CSP hanya mengizinkan gambar dari 'self')
    const o = db.orders.find(x => x.id === qm[1] && x.user === s.user && x.gw && x.gw.qrUrl);
    if (!o) return fail(res, 404, 'QR tidak ditemukan.');
    try {
      const u = new URL(o.gw.qrUrl);
      if (u.host !== new URL(MT_BASE).host && !u.hostname.endsWith('.midtrans.com')) throw new Error('host');
      const r = await fetch(u, { signal: AbortSignal.timeout(15000) }), ct = r.headers.get('content-type') || '';
      if (!r.ok || !ct.startsWith('image/')) throw new Error('bad');
      res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff' });
      return res.end(Buffer.from(await r.arrayBuffer()));
    } catch (e) { return fail(res, 502, 'QR belum tersedia, coba muat ulang.'); }
  }
  let m = url.pathname.match(/^\/api\/orders\/([A-Z0-9]+)\/(paid|cancel)$/);
  if (m && req.method === 'POST') {
    sweep(); const o = db.orders.find(x => x.id === m[1] && x.user === s.user);
    if (!o) return fail(res, 404, 'Pesanan tidak ditemukan.');
    if (o.status !== ST.UNPAID) return fail(res, 409, 'Status pesanan sudah ' + o.status + '.');
    if (o.gw && m[2] === 'paid') return fail(res, 409, 'Pembayaran ini diverifikasi otomatis, tidak perlu konfirmasi.');
    if (o.gw && o.gw.provider !== 'xendit') { try { await mt('POST', '/v2/' + o.id + '/cancel'); } catch (e) {} }   // nonaktifkan QR agar tidak bisa dibayar lagi
    if (m[2] === 'paid') { o.status = ST.VERIFY; o.paidAt = Date.now(); tg('🔔 Pembeli menekan "Sudah Membayar" ' + o.id + '\n' + o.product + ' · ' + o.item + '\nID: ' + o.player + '\nTotal ' + rp(o.amount) + ' via ' + o.method + (o.proof ? ' (ada bukti)' : '') + '\nCek mutasi lalu verifikasi di Admin.'); } else o.status = ST.CANCELLED;
    save(); return send(res, 200, { serverTime: Date.now(), order: pub(o) });
  }

  /* ---- admin ---- */
  if (url.pathname.startsWith('/api/admin/')) {
    if (s.role !== 'admin') return fail(res, 403, 'Khusus admin.');
    if (route === 'GET /api/admin/orders') { sweep(); return send(res, 200, { orders: db.orders.slice().sort((a, c) => c.createdAt - a.createdAt) }); }
    if (route === 'GET /api/admin/users') return send(res, 200, { users: Object.entries(db.users).map(([u, r]) => ({ username: u, role: r.role, created: r.created, orders: db.orders.filter(o => o.user === u).length })) });
    m = url.pathname.match(/^\/api\/admin\/users\/([a-z0-9_]{3,20})\/reset$/);
    if (m && req.method === 'POST') {
      const rec = hasUser(m[1]) ? db.users[m[1]] : null; if (!rec) return fail(res, 404, 'Akun tidak ditemukan.');
      if (rec.role === 'admin') return fail(res, 400, 'Akun admin tidak bisa direset lewat sini.');
      const alpha = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', code = Array.from(crypto.randomBytes(8), x => alpha[x % alpha.length]).join('');
      rec.reset = { h: sha(code), exp: Date.now() + 30 * 60000 }; save();
      return send(res, 200, { code, minutes: 30 });
    }
    if (route === 'GET /api/admin/promos') return send(res, 200, { promos: Object.entries(db.settings.promos).map(([code, p]) => Object.assign({ code, used: db.orders.filter(o => o.promo === code && ![ST.EXPIRED, ST.CANCELLED].includes(o.status)).length }, p)) });
    if (route === 'PUT /api/admin/promos') {
      const code = String(b.code || '').trim().toUpperCase(), n = v => Math.max(0, Math.round(Number(v) || 0));
      if (!/^[A-Z0-9]{3,20}$/.test(code)) return fail(res, 400, 'Kode 3–20 karakter: huruf besar/angka.');
      const type = b.type === 'flat' ? 'flat' : 'percent', value = n(b.value);
      if (type === 'percent' && (value < 1 || value > 90)) return fail(res, 400, 'Persen diskon 1–90.');
      if (type === 'flat' && value < 500) return fail(res, 400, 'Diskon nominal minimal Rp500.');
      db.settings.promos[code] = { type, value, maxDiscount: n(b.maxDiscount), minPrice: n(b.minPrice), maxUses: n(b.maxUses), expires: b.expires ? Number(b.expires) || 0 : 0, active: b.active !== false };
      save(); return send(res, 200, { ok: true });
    }
    m = url.pathname.match(/^\/api\/admin\/promos\/([A-Z0-9]{3,20})$/);
    if (m && req.method === 'DELETE') { delete db.settings.promos[m[1]]; save(); return send(res, 200, { ok: true }); }
    m = url.pathname.match(/^\/api\/admin\/orders\/([A-Z0-9]+)\/proof$/);
    if (m && req.method === 'GET') {
      try { const buf = fs.readFileSync(path.join(PROOF_DIR, m[1] + '.jpg')); res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }); return res.end(buf); }
      catch (e) { return fail(res, 404, 'Bukti tidak ada.'); }
    }
    if (route === 'GET /api/admin/settings') return send(res, 200, adminSettings());
    m = url.pathname.match(/^\/api\/admin\/orders\/([A-Z0-9]+)$/);
    if (m && req.method === 'POST') {
      const o = db.orders.find(x => x.id === m[1]); if (!o) return fail(res, 404, 'Pesanan tidak ditemukan.');
      if (!Object.values(ST).includes(b.status)) return fail(res, 400, 'Status tidak valid.');
      o.status = b.status; if (b.status === ST.DONE) o.doneAt = Date.now(); save();
      if (b.status === ST.PAID) fulfill(o).catch(e => console.error('Fulfill gagal:', e.message));   // admin sudah memverifikasi pembayaran manual
      return send(res, 200, { order: o });
    }
    if (m && req.method === 'DELETE') { db.orders = db.orders.filter(x => x.id !== m[1]); rmProof(m[1]); save(); return send(res, 200, { ok: true }); }
    if (route === 'DELETE /api/admin/orders') { db.orders.forEach(o => rmProof(o.id)); db.orders = []; save(); return send(res, 200, { ok: true }); }
    if (route === 'PUT /api/admin/settings') {
      if (typeof b.paymentDisabled === 'boolean') db.settings.paymentDisabled = b.paymentDisabled;
      for (const [n, v] of Object.entries(b.products || {})) {
        if (!PRODUCTS[n]) return fail(res, 400, 'Produk tidak dikenal: ' + n);
        if (!validPrices(v.prices)) return fail(res, 400, 'Harga tidak valid (6 paket, minimal Rp1.000).');
        db.settings.products[n] = { prices: v.prices, disabled: !!v.disabled };
      }
      for (const n of b.reset || []) delete db.settings.products[n];
      for (const [n, arr] of Object.entries(b.skus || {})) {
        if (!PRODUCTS[n]) return fail(res, 400, 'Produk tidak dikenal: ' + n);
        if (!Array.isArray(arr) || arr.length !== 6 || !arr.every(x => /^[A-Za-z0-9_.-]{0,40}$/.test(String(x)))) return fail(res, 400, 'Kode SKU tidak valid (huruf, angka, - _ .).');
        db.settings.skus[n] = arr.map(x => String(x).trim());
      }
      save(); return send(res, 200, adminSettings());
    }
    if (route === 'POST /api/admin/password') {
      const rec = db.users[s.user];
      if (!await checkPw(String(b.current || ''), rec.hash)) return fail(res, 400, 'Password saat ini salah.');
      const n = String(b.next || ''); if (n.length < 8 || n.length > 100) return fail(res, 400, 'Password baru minimal 8 karakter.');
      rec.hash = await hashPw(n);
      for (const [k, v] of Object.entries(db.sessions)) if (v.user === s.user && k !== s.key) delete db.sessions[k];
      save(); return send(res, 200, { ok: true });
    }
  }
  return fail(res, 404, 'Endpoint tidak ditemukan.');
}

/* ---------- file statis ---------- */
const PAGES = { '/': 'index.html', '/index.html': 'index.html', '/admin': 'admin.html', '/admin.html': 'admin.html' };
const cache = {};
const SEC = Object.assign(COOKIE_SECURE ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}, {
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'"
});
function page(req, res, name) {
  const f = path.join(PUBLIC, name);
  let c = cache[name];
  if (!c || (process.env.NODE_ENV !== 'production' && c.m !== fs.statSync(f).mtimeMs)) {
    const raw = fs.readFileSync(f); c = cache[name] = { raw, gz: zlib.gzipSync(raw), m: fs.statSync(f).mtimeMs };
  }
  const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  res.writeHead(200, Object.assign({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'Vary': 'Accept-Encoding' }, gz ? { 'Content-Encoding': 'gzip' } : {}, SEC));
  res.end(gz ? c.gz : c.raw);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'POST' && url.pathname === '/api/payment/midtrans/notify') return await midtransNotify(req, res);
    if (req.method === 'POST' && url.pathname === '/api/payment/xendit/notify') return await xenditNotify(req, res);
    if (req.method === 'POST' && url.pathname === '/api/supplier/digiflazz/notify') return await digiflazzNotify(req, res);
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (url.pathname === '/robots.txt') { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('User-agent: *\nDisallow: /admin\nDisallow: /api/\n'); }
    if (req.method === 'GET' && PAGES[url.pathname]) return page(req, res, PAGES[url.pathname]);
    res.writeHead(404, Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, SEC)); res.end('Tidak ditemukan');
  } catch (e) { console.error(e); if (!res.headersSent) fail(res, 500, 'Terjadi kesalahan pada server.'); }
});
seedAdmin().then(() => server.listen(PORT, HOST, () => console.log('DITZ MARKET berjalan di http://' + (HOST === '0.0.0.0' ? 'localhost' : HOST) + ':' + PORT + '  (admin: /admin)\nMidtrans (QRIS/GoPay): ' + (MT_KEY ? 'AKTIF (' + (MT_BASE.includes('sandbox') ? 'sandbox' : 'production') + ')' : 'nonaktif') + ' | Xendit (DANA): ' + (XD_ON ? 'AKTIF' : 'nonaktif') + ' | Digiflazz: ' + (DF_ON ? 'AKTIF' : 'nonaktif') + ' | Telegram: ' + (TG_TOKEN && TG_CHAT ? 'AKTIF' : 'nonaktif'))));
