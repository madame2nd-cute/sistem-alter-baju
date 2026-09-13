const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DB_PATH = path.join(__dirname, 'data', 'db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = process.env.PORT || 3000;

/* ============ DEFAULT DATA ============ */
const DEFAULT_DB = {
  settings: {
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
  },
  customers: {},
  vouchers: {},
  orders: {},
  counters: { customer:0, order:0 },
};

/* ============ DB HELPERS ============ */
function loadDB(){
  try{
    if(!fs.existsSync(DB_PATH)){ saveDB(DEFAULT_DB); return JSON.parse(JSON.stringify(DEFAULT_DB)); }
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
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
  return c.services.reduce((s,row)=>{
    const svc = services.find(x=>x.id===row.svcId);
    return s + (svc ? priceFor(svc, c.jenis) : (row.price||0));
  },0) * (parseInt(c.qty)||1);
}

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

/* ============ RESPONSE HELPERS ============ */
function sendJSON(res, status, obj){
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type':'application/json', 'Access-Control-Allow-Origin':'*' });
  res.end(body);
}
function readBody(req){
  return new Promise((resolve, reject)=>{
    let chunks = [];
    let size = 0;
    req.on('data', d=>{ size += d.length; if(size > 15*1024*1024){ reject(new Error('Payload terlalu besar')); req.destroy(); return; } chunks.push(d); });
    req.on('end', ()=>{
      try{ resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}); }
      catch(e){ reject(e); }
    });
    req.on('error', reject);
  });
}
function requireAdmin(req, db){
  const pin = req.headers['x-admin-pin'];
  return pin === db.settings.adminPin;
}

/* ============ STATIC FILE SERVING ============ */
const MIME = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css' };
function serveStatic(req, res){
  let filePath = req.url === '/' ? '/index.html' : req.url;
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
    res.writeHead(204, { 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Headers':'Content-Type, X-Admin-Pin', 'Access-Control-Allow-Methods':'GET,POST,OPTIONS' });
    res.end();
    return;
  }

  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  try{
    if(!p.startsWith('/api/')){ return serveStatic(req, res); }

    const db = loadDB();

    // ---- PUBLIC ----
    if(p === '/api/settings' && req.method === 'GET'){
      const s = JSON.parse(JSON.stringify(db.settings));
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

      let voucherDiscount = 0;
      let appliedCode = null;
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
        postage: { amount:null, dueDate:null, proof:null, paid:false, confirmed:false },
        review: null,
      };

      if(appliedCode){ db.vouchers[appliedCode].used = true; }
      db.orders[noPesanan] = order;
      saveDB(db);
      return sendJSON(res, 200, { ok:true, order });
    }

    // GET /api/order/:no?phone=...
    let m = p.match(/^\/api\/order\/([^\/]+)$/);
    if(m && req.method === 'GET'){
      const o = db.orders[m[1]];
      const phone = normPhone(url.searchParams.get('phone'));
      if(!o || o.phone !== phone) return sendJSON(res, 404, { error:'Pesanan tidak dijumpai. Sila semak semula no. pesanan dan telefon.' });
      return sendJSON(res, 200, o);
    }

    // POST /api/order/:no/deposit-proof {phone, proofImage}
    m = p.match(/^\/api\/order\/([^\/]+)\/deposit-proof$/);
    if(m && req.method === 'POST'){
      const body = await readBody(req);
      const o = db.orders[m[1]];
      if(!o || o.phone !== normPhone(body.phone)) return sendJSON(res, 404, { error:'Pesanan tidak dijumpai.' });
      o.depositPaid = true; o.depositProof = body.proofImage;
      saveDB(db);
      return sendJSON(res, 200, { ok:true });
    }

    // POST /api/order/:no/postage-proof
    m = p.match(/^\/api\/order\/([^\/]+)\/postage-proof$/);
    if(m && req.method === 'POST'){
      const body = await readBody(req);
      const o = db.orders[m[1]];
      if(!o || o.phone !== normPhone(body.phone)) return sendJSON(res, 404, { error:'Pesanan tidak dijumpai.' });
      o.postage.paid = true; o.postage.proof = body.proofImage;
      saveDB(db);
      return sendJSON(res, 200, { ok:true });
    }

    // POST /api/order/:no/review
    m = p.match(/^\/api\/order\/([^\/]+)\/review$/);
    if(m && req.method === 'POST'){
      const body = await readBody(req);
      const o = db.orders[m[1]];
      if(!o || o.phone !== normPhone(body.phone)) return sendJSON(res, 404, { error:'Pesanan tidak dijumpai.' });
      o.review = { rating: parseInt(body.rating), comment: (body.comment||'').trim(), date: todayISO() };
      saveDB(db);
      return sendJSON(res, 200, { ok:true });
    }

    // ---- ADMIN (require x-admin-pin header) ----
    if(p.startsWith('/api/admin/')){
      if(!requireAdmin(req, db)) return sendJSON(res, 401, { error:'PIN admin salah.' });

      if(p === '/api/admin/orders' && req.method === 'GET'){
        return sendJSON(res, 200, Object.values(db.orders).sort((a,b)=>b.noPesanan.localeCompare(a.noPesanan)));
      }
      if(p === '/api/admin/customers' && req.method === 'GET'){
        return sendJSON(res, 200, db.customers);
      }
      if(p === '/api/admin/settings' && req.method === 'POST'){
        const body = await readBody(req);
        db.settings = Object.assign({}, db.settings, body);
        saveDB(db);
        return sendJSON(res, 200, { ok:true, settings: db.settings });
      }
      m = p.match(/^\/api\/admin\/order\/([^\/]+)\/status$/);
      if(m && req.method === 'POST'){
        const body = await readBody(req);
        const o = db.orders[m[1]]; if(!o) return sendJSON(res, 404, { error:'Tidak dijumpai' });
        o.status = body.status;
        if(body.status === 'Dalam proses' && !o.tarikhTerima) o.tarikhTerima = todayISO();
        saveDB(db);
        return sendJSON(res, 200, { ok:true, order:o });
      }
      m = p.match(/^\/api\/admin\/order\/([^\/]+)\/confirm-deposit$/);
      if(m && req.method === 'POST'){
        const o = db.orders[m[1]]; if(!o) return sendJSON(res, 404, { error:'Tidak dijumpai' });
        o.depositConfirmed = true; o.status = 'Order diterima';
        saveDB(db);
        return sendJSON(res, 200, { ok:true, order:o });
      }
      m = p.match(/^\/api\/admin\/order\/([^\/]+)\/set-postage$/);
      if(m && req.method === 'POST'){
        const body = await readBody(req);
        const o = db.orders[m[1]]; if(!o) return sendJSON(res, 404, { error:'Tidak dijumpai' });
        const amount = parseFloat(body.amount);
        if(!amount || amount<=0) return sendJSON(res, 400, { error:'Jumlah kos pos tidak sah.' });
        o.postage.amount = amount;
        o.postage.dueDate = addDays(todayISO(), db.settings.postageDueDays);
        o.status = 'Menunggu bayaran pos';
        saveDB(db);
        return sendJSON(res, 200, { ok:true, order:o });
      }
      m = p.match(/^\/api\/admin\/order\/([^\/]+)\/confirm-postage$/);
      if(m && req.method === 'POST'){
        const o = db.orders[m[1]]; if(!o) return sendJSON(res, 404, { error:'Tidak dijumpai' });
        o.postage.confirmed = true; o.status = 'Bayaran pos disahkan';
        saveDB(db);
        return sendJSON(res, 200, { ok:true, order:o });
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

server.listen(PORT, ()=>{ console.log('Tailor app server running on port ' + PORT); });
