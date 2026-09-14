const http = require('http');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = process.env.PORT || 3000;

/* ============ DEFAULT DATA ============ */
const DEFAULT_SETTINGS = {
  services: [
    {id:'s1', name:'Pendekkan lengan', priceDefault:15, priceJeans:22},
    {id:'s2', name:'Kecilkan bahu', priceDefault:20, priceJeans:28},
    {id:'s3', name:'Pendekkan seluar / labuh baju', priceDefault:18, priceJeans:25},
    {id:'s4', name:'Kecilkan pinggang', priceDefault:20, priceJeans:28},
    {id:'s5', name:'Tukar zip', priceDefault:12, priceJeans:18},
    {id:'s6', name:'Tampal lubang / koyak', priceDefault:10, priceJeans:14},
  ],
  discount:{ enabled:false, basis:'amount', threshold:100, type:'fixed', value:5, ukurEnabled:false, ukurValue:2 },
  voucher:{ enabled:false, appliesTo:'price', type:'percent', value:10, validityDays:30 },
  measuringFee:{ enabled:false, basis:'flat', amount:10 },
  appointmentSlots:['2026-09-15','2026-09-18','2026-09-22'],
  adminPin: '1234',
  deposit:{ enabled:false, type:'percent', value:20 },
  payment:{ bankName:'', bankAccount:'', bankHolder:'', qrImage:null },
  postageDueDays: 3,
  postageRates: {
    zones: [
      {id:'z1', name:'Zon 1 — Dalam Lembah Klang', first1kg:6.8, addKgUnder10:1.3, addKgOver10:2},
      {id:'z2', name:'Zon 2 — Antara negeri (Semenanjung)', first1kg:6.8, addKgUnder10:1.3, addKgOver10:2},
      {id:'z3', name:'Zon 3 — Dalam negeri (Semenanjung/Sabah/Sarawak)', first1kg:6.8, addKgUnder10:1.3, addKgOver10:2},
      {id:'z4', name:'Zon 4 — Semenanjung ke Sabah/Sarawak', first1kg:16, addKgUnder10:12, addKgOver10:13},
      {id:'z5', name:'Zon 5 — Sabah/Sarawak ke Semenanjung', first1kg:10, addKgUnder10:8, addKgOver10:9},
    ]
  },
  notify: { adminEmail:'', smtpUser:'', smtpPass:'', soundEnabled:true, emailEnabled:false },
  dataRetentionMonths: 6,
  reviewLimits: { maxWords:50, maxPhotos:2, maxVideoSeconds:15 },
};

const DEFAULT_DB = {
  settings: DEFAULT_SETTINGS,
  customers: {},
  vouchers: {},
  orders: {},
  counters: { customer:0, order:0 },
};

/* ============ DB HELPERS ============ */
function loadDB(){
  try{
    if(!fs.existsSync(DB_PATH)){ saveDB(DEFAULT_DB); return JSON.parse(JSON.stringify(DEFAULT_DB)); }
    const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    // fill in any missing default settings keys (for upgrades)
    db.settings = Object.assign({}, DEFAULT_SETTINGS, db.settings);
    db.settings.postageRates = db.settings.postageRates || DEFAULT_SETTINGS.postageRates;
    db.settings.notify = Object.assign({}, DEFAULT_SETTINGS.notify, db.settings.notify);
    db.settings.reviewLimits = Object.assign({}, DEFAULT_SETTINGS.reviewLimits, db.settings.reviewLimits);
    return db;
  }catch(e){
    console.error('DB load error, using default', e);
    return JSON.parse(JSON.stringify(DEFAULT_DB));
  }
}
function saveDB(db){
  fs.mkdirSync(path.dirname(DB_PATH), { recursive:true });
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function normPhone(raw){
  let d = (raw||'').replace(/[^0-9]/g,'');
  if(d.startsWith('60')) d = '0'+d.slice(2);
  if(!d.startsWith('0') && d.length>0) d = '0'+d;
  return d;
}
function todayISO(){ return new Date().toISOString().slice(0,10); }
function addDays(dateStr, days){ const d=new Date(dateStr+'T00:00:00'); d.setDate(d.getDate()+days); return d.toISOString().slice(0,10); }
function addWorkingDays(dateStr, days){ let d=new Date(dateStr+'T00:00:00'); let added=0; while(added<days){ d.setDate(d.getDate()+1); const wd=d.getDay(); if(wd!==0&&wd!==6) added++; } return d.toISOString().slice(0,10); }
function priceFor(svc, jenis){ return jenis==='seluar_jeans' ? svc.priceJeans : svc.priceDefault; }
function catTotal(c, services){
  return (c.services||[]).reduce((s,row)=>{
    const svc = services.find(x=>x.id===row.svcId);
    return s + (svc ? priceFor(svc, c.jenis) : (row.price||0));
  },0) * (parseInt(c.qty)||1);
}
function fmt(n){ return 'RM'+(Math.round(n*100)/100).toFixed(2); }

function computeTotals(db, categories, hantar){
  const services = db.settings.services;
  const subtotal = categories.reduce((s,c)=>s+catTotal(c, services),0);
  const totalQty = categories.reduce((s,c)=>s+(parseInt(c.qty)||1),0);
  const urgentQty = categories.filter(c=>c.urgent).reduce((s,c)=>s+(parseInt(c.qty)||1),0);
  const isUkur = hantar==='ukur';

  let measuringFee = 0;
  if(isUkur && db.settings.measuringFee.enabled){
    measuringFee = db.settings.measuringFee.basis==='flat' ? db.settings.measuringFee.amount : db.settings.measuringFee.amount*totalQty;
  }
  let priceDiscount = 0;
  const disc = db.settings.discount;
  const discOn = isUkur ? disc.ukurEnabled : disc.enabled;
  if(discOn && subtotal>0){
    const val = isUkur ? disc.ukurValue : disc.value;
    const basisVal = disc.basis==='amount' ? subtotal : totalQty;
    const tiers = Math.floor(basisVal / disc.threshold);
    if(tiers>=1){ priceDiscount = disc.type==='percent' ? subtotal*(val/100) : tiers*val; }
  }
  return { subtotal, totalQty, urgentQty, measuringFee, priceDiscount };
}

function calcPostage(rate, weightKg){
  let w = Math.ceil(parseFloat(weightKg)||1);
  if(w<1) w = 1;
  let cost = rate.first1kg;
  let remaining = w - 1;
  const under10 = Math.min(remaining, 9);
  cost += under10 * rate.addKgUnder10;
  remaining -= under10;
  if(remaining > 0){ cost += remaining * rate.addKgOver10; }
  return Math.round(cost*100)/100;
}

/* ============ WHATSAPP MESSAGE TEMPLATES ============ */
function msgOrderConfirmed(o){ return `Salam ${o.nama}, pesanan ${o.noPesanan} anda telah disahkan dan bayaran diterima. Kami sedang menunggu ketibaan pakaian anda untuk mula diproses.`; }
function msgArrived(o){ return `Salam ${o.nama}, pakaian anda (${o.noPesanan}) telah kami terima dan akan segera diproses.`; }
function msgReadyPickup(o){ return `Salam ${o.nama}, pakaian anda (${o.noPesanan}) telah siap dan sedia untuk diambil sendiri atau oleh runner.`; }
function msgInvoicePos(o, baseUrl){
  return `Salam ${o.nama}, pakaian anda (${o.noPesanan}) telah siap dibungkus.\n\nInvois:\nBaki upah alter: ${fmt(o.finalPayment.balance)}\nKos pos: ${fmt(o.finalPayment.postage)}\nJumlah perlu dibayar: ${fmt(o.finalPayment.total)}\n\nSila jelaskan sebelum ${o.finalPayment.dueDate} di ${baseUrl} (tab Pusat Bayaran) menggunakan no. pesanan dan no. telefon anda.`;
}
function msgFinalPaymentConfirmed(o){ return `Salam ${o.nama}, bayaran untuk pesanan ${o.noPesanan} telah kami terima dan sahkan. Nombor penjejakan akan dikemaskini tidak lama lagi.`; }
function msgTracking(o){ return `Salam ${o.nama}, pesanan ${o.noPesanan} sedang menunggu kutipan courier.\nCourier: ${o.courier}\nNo. penjejakan: ${o.trackingNo}`; }
function msgNear(o){ return `Salam ${o.nama}, pesanan ${o.noPesanan} anda dijangka tiba tidak lama lagi. Sila bersedia menerimanya.`; }
function msgDelivered(o){ return `Salam ${o.nama}, pesanan ${o.noPesanan} telah dihantar ke alamat anda. Jika belum diterima, sila hubungi kami dalam tempoh 24 jam.`; }
function msgReviewRequest(o, baseUrl){ return `Salam ${o.nama}, terima kasih kerana menggunakan perkhidmatan kami! Pesanan ${o.noPesanan} telah selesai. Kami amat menghargai jika anda dapat berikan ulasan di ${baseUrl} (tab Status), menggunakan no. pesanan dan no. telefon anda.`; }

function baseUrlFrom(req){
  if(req.headers.origin) return req.headers.origin;
  return 'https://' + (req.headers.host || 'localhost');
}

/* ============ EMAIL NOTIFICATION (best-effort, needs nodemailer) ============ */
async function notifyAdminEmail(db, subject, text){
  const n = db.settings.notify;
  if(!n || !n.emailEnabled || !n.adminEmail || !n.smtpUser || !n.smtpPass) return;
  try{
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com', port: 587, secure:false,
      auth: { user: n.smtpUser, pass: n.smtpPass },
    });
    await transporter.sendMail({ from: n.smtpUser, to: n.adminEmail, subject, text });
  }catch(e){
    console.error('Email notify failed (semak setting SMTP / pastikan nodemailer terpasang):', e.message);
  }
}

/* ============ DATA RETENTION (6 bulan) ============ */
function purgeOldOrderDetails(db){
  const months = db.settings.dataRetentionMonths || 6;
  const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth() - months);
  let changed = false;
  Object.values(db.orders).forEach(o=>{
    if(o.detailsPurged) return;
    const orderDate = new Date(o.tarikhOrder+'T00:00:00');
    if(orderDate < cutoff){
      o.categories = [];
      o.depositProof = null;
      if(o.finalPayment) o.finalPayment.proof = null;
      o.deliveryProofPhoto = null;
      if(o.review){ o.review.photos = []; o.review.video = null; }
      o.detailsPurged = true;
      changed = true;
    }
  });
  if(changed) saveDB(db);
}

/* ============ RESPONSE HELPERS ============ */
function sendJSON(res, status, obj){
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type':'application/json', 'Access-Control-Allow-Origin':'*' });
  res.end(body);
}
function readBody(req){
  return new Promise((resolve, reject)=>{
    let chunks = []; let size = 0;
    req.on('data', d=>{ size += d.length; if(size > 20*1024*1024){ reject(new Error('Payload terlalu besar')); req.destroy(); return; } chunks.push(d); });
    req.on('end', ()=>{ try{ resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}); } catch(e){ reject(e); } });
    req.on('error', reject);
  });
}
function requireAdmin(req, db){ return req.headers['x-admin-pin'] === db.settings.adminPin; }

/* ============ STATIC FILE SERVING ============ */
const MIME = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css' };
function serveStatic(req, res){
  let filePath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  filePath = path.join(PUBLIC_DIR, filePath);
  if(!filePath.startsWith(PUBLIC_DIR)){ res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, data)=>{
    if(err){ res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

/* ============ ROUTES ============ */
const server = http.createServer(async (req, res)=>{
  if(req.method === 'OPTIONS'){
    res.writeHead(204, { 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Headers':'Content-Type, X-Admin-Pin', 'Access-Control-Allow-Methods':'GET,POST,DELETE,OPTIONS' });
    res.end();
    return;
  }

  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  try{
    if(!p.startsWith('/api/')){ return serveStatic(req, res); }

    const db = loadDB();
    purgeOldOrderDetails(db);

    /* ---- PUBLIC ---- */
    if(p === '/api/settings' && req.method === 'GET'){
      const s = JSON.parse(JSON.stringify(db.settings));
      delete s.smtpPass; // never expose password to public settings fetch used by customer form
      if(s.notify) delete s.notify.smtpPass;
      return sendJSON(res, 200, s);
    }

    if(p === '/api/admin/login' && req.method === 'POST'){
      const body = await readBody(req);
      return sendJSON(res, 200, { ok: body.pin === db.settings.adminPin });
    }

    if(p === '/api/voucher/check' && req.method === 'POST'){
      const body = await readBody(req);
      const code = (body.code||'').toUpperCase();
      const phone = normPhone(body.phone);
      const v = db.vouchers[code];
      if(!v) return sendJSON(res, 200, { valid:false, reason:'Kod baucer tidak sah.' });
      if(v.used) return sendJSON(res, 200, { valid:false, reason:'Baucer ini sudah digunakan.' });
      if(v.expiry < todayISO()) return sendJSON(res, 200, { valid:false, reason:'Baucer telah luput.' });
      if(v.phone !== phone) return sendJSON(res, 200, { valid:false, reason:'Diskaun tidak berjaya. Data pelanggan tiada rekod dalam sistem.' });
      return sendJSON(res, 200, { valid:true, appliesTo: db.settings.voucher.appliesTo, type: db.settings.voucher.type, value: db.settings.voucher.value });
    }

    if(p === '/api/order' && req.method === 'POST'){
      const body = await readBody(req);
      const { nama, alamat, phone: rawPhone, hantar, appointmentDate, ambil, bayar, categories, voucherCode, plat } = body;
      const phone = normPhone(rawPhone);
      if(!nama || !alamat || phone.length<10) return sendJSON(res, 400, { error:'Sila lengkapkan nama, alamat dan no. telefon yang sah.' });
      if(!Array.isArray(categories) || categories.length===0 || categories.every(c=>!c.services || c.services.length===0)){
        return sendJSON(res, 400, { error:'Sila pilih sekurang-kurangnya satu servis.' });
      }
      const missingPhoto = categories.some(c=>!c.photoRequiredData && !(c.photoNote && c.photoNote.trim()));
      if(missingPhoto) return sendJSON(res, 400, { error:'Gambar pakaian (wajib) atau penerangan gantian belum diisi untuk semua kategori.' });

      const calc = computeTotals(db, categories, hantar);
      if(calc.urgentQty > 2) return sendJSON(res, 400, { error:'Pesanan urgent tidak boleh melebihi 2 helai.' });

      let voucherDiscount = 0; let appliedCode = null;
      if(voucherCode && db.settings.voucher.enabled){
        const code = voucherCode.toUpperCase();
        const v = db.vouchers[code];
        if(v && !v.used && v.expiry >= todayISO() && v.phone === phone){
          appliedCode = code;
          if(db.settings.voucher.appliesTo === 'price'){
            voucherDiscount = db.settings.voucher.type==='percent' ? calc.subtotal*(db.settings.voucher.value/100) : db.settings.voucher.value;
          }
        }
      }

      const grandTotal = Math.max(0, calc.subtotal - calc.priceDiscount - voucherDiscount) + calc.measuringFee;

      let kodPelanggan = Object.keys(db.customers).find(k=>db.customers[k].phone===phone);
      if(!kodPelanggan){
        db.counters.customer++;
        kodPelanggan = 'P'+String(db.counters.customer).padStart(4,'0');
        db.customers[kodPelanggan] = { nama, alamat, phone };
      }

      db.counters.order++;
      const noPesanan = 'PSN'+String(db.counters.order).padStart(4,'0');
      const receiptNo = 'RCT-'+String(db.counters.order).padStart(4,'0');

      const depositEnabled = db.settings.deposit.enabled;
      const depositAmount = depositEnabled ? Math.min(grandTotal, db.settings.deposit.type==='percent' ? grandTotal*(db.settings.deposit.value/100) : db.settings.deposit.value) : 0;

      const order = {
        noPesanan, receiptNo, kodPelanggan, nama, alamat, phone, plat: plat||'',
        hantar, appointmentDate: appointmentDate||null, ambil, bayar,
        categories,
        total: { subtotal: calc.subtotal, priceDiscount: calc.priceDiscount, voucherDiscount, measuringFee: calc.measuringFee, grandTotal, urgentQty: calc.urgentQty, totalQty: calc.totalQty },
        voucherUsed: appliedCode,
        status: depositEnabled ? 'Menunggu deposit' : 'Order diterima',
        tarikhOrder: todayISO(), tarikhTerima: null,
        urgent: categories.some(c=>c.urgent),
        depositRequired: depositEnabled, depositAmount, depositPaid:false, depositProof:null, depositConfirmed: !depositEnabled,
        finalPayment: { balance:0, postage:0, total:0, dueDate:null, proof:null, paid:false, confirmed:false },
        courier:null, trackingNo:null, deliveryProofPhoto:null,
        review: null, detailsPurged:false,
      };

      if(appliedCode){ db.vouchers[appliedCode].used = true; }
      db.orders[noPesanan] = order;
      saveDB(db);

      notifyAdminEmail(db, `Pesanan baharu: ${noPesanan}`, `Pesanan baharu daripada ${nama} (${phone}).\nJumlah: ${fmt(grandTotal)}\nStatus: ${order.status}`);

      return sendJSON(res, 200, { ok:true, order });
    }

    let m = p.match(/^\/api\/order\/([^\/]+)$/);
    if(m && req.method === 'GET'){
      const o = db.orders[m[1]];
      const phone = normPhone(url.searchParams.get('phone'));
      if(!o || o.phone !== phone) return sendJSON(res, 404, { error:'Pesanan tidak dijumpai. Sila semak semula no. pesanan dan telefon.' });
      return sendJSON(res, 200, o);
    }

    m = p.match(/^\/api\/order\/([^\/]+)\/deposit-proof$/);
    if(m && req.method === 'POST'){
      const body = await readBody(req);
      const o = db.orders[m[1]];
      if(!o || o.phone !== normPhone(body.phone)) return sendJSON(res, 404, { error:'Pesanan tidak dijumpai.' });
      o.depositPaid = true; o.depositProof = body.proofImage;
      saveDB(db);
      notifyAdminEmail(db, `Bukti deposit diterima: ${o.noPesanan}`, `${o.nama} telah muat naik bukti bayaran deposit untuk pesanan ${o.noPesanan}. Sila semak dan sahkan.`);
      return sendJSON(res, 200, { ok:true });
    }

    m = p.match(/^\/api\/order\/([^\/]+)\/final-payment-proof$/);
    if(m && req.method === 'POST'){
      const body = await readBody(req);
      const o = db.orders[m[1]];
      if(!o || o.phone !== normPhone(body.phone)) return sendJSON(res, 404, { error:'Pesanan tidak dijumpai.' });
      o.finalPayment.paid = true; o.finalPayment.proof = body.proofImage;
      saveDB(db);
      notifyAdminEmail(db, `Bukti bayaran diterima: ${o.noPesanan}`, `${o.nama} telah muat naik bukti bayaran akhir/kos pos untuk pesanan ${o.noPesanan}. Sila semak dan sahkan.`);
      return sendJSON(res, 200, { ok:true });
    }

    m = p.match(/^\/api\/order\/([^\/]+)\/review$/);
    if(m && req.method === 'POST'){
      const body = await readBody(req);
      const o = db.orders[m[1]];
      if(!o || o.phone !== normPhone(body.phone)) return sendJSON(res, 404, { error:'Pesanan tidak dijumpai.' });
      const limits = db.settings.reviewLimits;
      let comment = (body.comment||'').trim();
      const words = comment.split(/\s+/).filter(Boolean);
      if(words.length > limits.maxWords) comment = words.slice(0, limits.maxWords).join(' ');
      const photos = Array.isArray(body.photos) ? body.photos.slice(0, limits.maxPhotos) : [];
      o.review = { rating: parseInt(body.rating), comment, photos, video: body.video || null, date: todayISO() };
      saveDB(db);
      return sendJSON(res, 200, { ok:true });
    }

    /* ---- ADMIN ---- */
    if(p.startsWith('/api/admin/')){
      if(!requireAdmin(req, db)) return sendJSON(res, 401, { error:'PIN admin salah.' });
      const baseUrl = baseUrlFrom(req);

      if(p === '/api/admin/orders' && req.method === 'GET'){
        return sendJSON(res, 200, Object.values(db.orders).sort((a,b)=>b.noPesanan.localeCompare(a.noPesanan)));
      }
      if(p === '/api/admin/customers' && req.method === 'GET'){
        const stats = {};
        Object.values(db.orders).forEach(o=>{
          if(!stats[o.kodPelanggan]) stats[o.kodPelanggan] = { orderCount:0, ratings:[] };
          stats[o.kodPelanggan].orderCount++;
          if(o.review) stats[o.kodPelanggan].ratings.push(o.review.rating);
        });
        const result = {};
        Object.entries(db.customers).forEach(([kod, c])=>{
          const s = stats[kod] || { orderCount:0, ratings:[] };
          const avgRating = s.ratings.length ? (s.ratings.reduce((a,b)=>a+b,0)/s.ratings.length) : null;
          result[kod] = Object.assign({}, c, { orderCount: s.orderCount, avgRating });
        });
        return sendJSON(res, 200, result);
      }
      if(p === '/api/admin/export' && req.method === 'GET'){
        return sendJSON(res, 200, db);
      }
      m = p.match(/^\/api\/admin\/customer\/([^\/]+)\/delete$/);
      if(m && req.method === 'DELETE'){
        const kod = m[1];
        delete db.customers[kod];
        Object.keys(db.orders).forEach(no=>{ if(db.orders[no].kodPelanggan===kod) delete db.orders[no]; });
        saveDB(db);
        return sendJSON(res, 200, { ok:true });
      }
      if(p === '/api/admin/settings' && req.method === 'POST'){
        const body = await readBody(req);
        db.settings = Object.assign({}, db.settings, body);
        saveDB(db);
        const safe = JSON.parse(JSON.stringify(db.settings));
        return sendJSON(res, 200, { ok:true, settings: safe });
      }

      // --- generic order lifecycle actions ---
      m = p.match(/^\/api\/admin\/order\/([^\/]+)\/confirm-deposit$/);
      if(m && req.method === 'POST'){
        const o = db.orders[m[1]]; if(!o) return sendJSON(res, 404, { error:'Tidak dijumpai' });
        o.depositConfirmed = true; o.status = 'Order diterima';
        saveDB(db);
        return sendJSON(res, 200, { ok:true, order:o });
      }
      m = p.match(/^\/api\/admin\/order\/([^\/]+)\/confirm-order$/);
      if(m && req.method === 'POST'){
        const o = db.orders[m[1]]; if(!o || o.status!=='Order diterima') return sendJSON(res, 400, { error:'Status tidak sepadan.' });
        const message = msgOrderConfirmed(o);
        o.status = 'Menunggu pakaian sampai';
        saveDB(db);
        return sendJSON(res, 200, { ok:true, order:o, message });
      }
      m = p.match(/^\/api\/admin\/order\/([^\/]+)\/mark-arrived$/);
      if(m && req.method === 'POST'){
        const o = db.orders[m[1]]; if(!o || o.status!=='Menunggu pakaian sampai') return sendJSON(res, 400, { error:'Status tidak sepadan.' });
        o.tarikhTerima = todayISO(); o.status = 'Dalam proses';
        const message = msgArrived(o);
        saveDB(db);
        return sendJSON(res, 200, { ok:true, order:o, message });
      }
      m = p.match(/^\/api\/admin\/order\/([^\/]+)\/mark-packed$/);
      if(m && req.method === 'POST'){
        const o = db.orders[m[1]]; if(!o || o.status!=='Dalam proses') return sendJSON(res, 400, { error:'Status tidak sepadan.' });
        let message = null;
        if(o.ambil === 'pos'){ o.status = 'Siap & dibungkus'; }
        else { o.status = 'Sedia diambil'; message = msgReadyPickup(o); }
        saveDB(db);
        return sendJSON(res, 200, { ok:true, order:o, message });
      }
      m = p.match(/^\/api\/admin\/order\/([^\/]+)\/set-postage$/);
      if(m && req.method === 'POST'){
        const body = await readBody(req);
        const o = db.orders[m[1]]; if(!o || o.status!=='Siap & dibungkus') return sendJSON(res, 400, { error:'Status tidak sepadan.' });
        const rate = db.settings.postageRates.zones.find(z=>z.id===body.zoneId);
        if(!rate) return sendJSON(res, 400, { error:'Zon tidak sah.' });
        const postageCost = calcPostage(rate, body.weightKg);
        const balance = Math.max(0, o.total.grandTotal - (o.depositRequired ? o.depositAmount : 0));
        o.finalPayment = { balance, postage: postageCost, total: Math.round((balance+postageCost)*100)/100, dueDate: addDays(todayISO(), db.settings.postageDueDays), proof:null, paid:false, confirmed:false };
        o.status = 'Menunggu bayaran pos';
        const message = msgInvoicePos(o, baseUrl);
        saveDB(db);
        return sendJSON(res, 200, { ok:true, order:o, message });
      }
      m = p.match(/^\/api\/admin\/order\/([^\/]+)\/confirm-final-payment$/);
      if(m && req.method === 'POST'){
        const o = db.orders[m[1]]; if(!o || o.status!=='Menunggu bayaran pos') return sendJSON(res, 400, { error:'Status tidak sepadan.' });
        o.finalPayment.confirmed = true; o.status = 'Bayaran pos disahkan';
        const message = msgFinalPaymentConfirmed(o);
        saveDB(db);
        return sendJSON(res, 200, { ok:true, order:o, message });
      }
      m = p.match(/^\/api\/admin\/order\/([^\/]+)\/set-tracking$/);
      if(m && req.method === 'POST'){
        const body = await readBody(req);
        const o = db.orders[m[1]]; if(!o || o.status!=='Bayaran pos disahkan') return sendJSON(res, 400, { error:'Status tidak sepadan.' });
        o.courier = body.courier || ''; o.trackingNo = body.trackingNo || '';
        o.status = 'Menunggu kutipan courier';
        const message = msgTracking(o);
        saveDB(db);
        return sendJSON(res, 200, { ok:true, order:o, message });
      }
      m = p.match(/^\/api\/admin\/order\/([^\/]+)\/mark-near$/);
      if(m && req.method === 'POST'){
        const o = db.orders[m[1]]; if(!o || o.status!=='Menunggu kutipan courier') return sendJSON(res, 400, { error:'Status tidak sepadan.' });
        o.status = 'Hampir tiba';
        const message = msgNear(o);
        saveDB(db);
        return sendJSON(res, 200, { ok:true, order:o, message });
      }
      m = p.match(/^\/api\/admin\/order\/([^\/]+)\/mark-delivered$/);
      if(m && req.method === 'POST'){
        const o = db.orders[m[1]]; if(!o || o.status!=='Hampir tiba') return sendJSON(res, 400, { error:'Status tidak sepadan.' });
        o.status = 'Dihantar';
        const message = msgDelivered(o);
        saveDB(db);
        return sendJSON(res, 200, { ok:true, order:o, message });
      }
      m = p.match(/^\/api\/admin\/order\/([^\/]+)\/upload-delivery-proof$/);
      if(m && req.method === 'POST'){
        const body = await readBody(req);
        const o = db.orders[m[1]]; if(!o || o.status!=='Dihantar') return sendJSON(res, 400, { error:'Status tidak sepadan.' });
        o.deliveryProofPhoto = body.photo;
        o.status = 'Selesai';
        const message = msgReviewRequest(o, baseUrl);
        saveDB(db);
        return sendJSON(res, 200, { ok:true, order:o, message });
      }
      m = p.match(/^\/api\/admin\/order\/([^\/]+)\/mark-collected$/);
      if(m && req.method === 'POST'){
        const o = db.orders[m[1]]; if(!o || o.status!=='Sedia diambil') return sendJSON(res, 400, { error:'Status tidak sepadan.' });
        o.status = 'Selesai';
        const message = msgReviewRequest(o, baseUrl);
        saveDB(db);
        return sendJSON(res, 200, { ok:true, order:o, message });
      }
      m = p.match(/^\/api\/admin\/order\/([^\/]+)\/release-voucher$/);
      if(m && req.method === 'POST'){
        const o = db.orders[m[1]]; if(!o) return sendJSON(res, 404, { error:'Tidak dijumpai' });
        const code = 'BCR'+Math.floor(1000+Math.random()*9000);
        db.vouchers[code] = { kodPelanggan:o.kodPelanggan, phone:o.phone, expiry: addDays(todayISO(), db.settings.voucher.validityDays), used:false };
        saveDB(db);
        return sendJSON(res, 200, { ok:true, code, expiry: db.vouchers[code].expiry });
      }

      return sendJSON(res, 404, { error:'Route admin tidak dijumpai.' });
    }

    return sendJSON(res, 404, { error:'Route tidak dijumpai.' });

  }catch(e){
    console.error(e);
    return sendJSON(res, 500, { error: 'Ralat pelayan: ' + e.message });
  }
});

// daily purge check while server is running
setInterval(()=>{ try{ const db = loadDB(); purgeOldOrderDetails(db); }catch(e){ console.error(e); } }, 24*60*60*1000);

server.listen(PORT, ()=>{ console.log('Tailor app server running on port ' + PORT); });
