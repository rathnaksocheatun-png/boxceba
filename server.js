const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');

const app = express();
app.use(express.json({ limit: '4mb' }));

/* ---------- MongoDB (connection reused between serverless calls) ---------- */
let clientPromise = null;
function getDb() {
  if (!process.env.MONGODB_URI) return Promise.reject(new Error('MONGODB_URI is not set'));
  if (!clientPromise) {
    clientPromise = new MongoClient(process.env.MONGODB_URI).connect().catch((e) => { clientPromise = null; throw e; });
  }
  return clientPromise.then((c) => c.db(process.env.DB_NAME || 'boxce'));
}

/* ---------- helpers ---------- */
function isAdmin(req) {
  const given = Buffer.from(String(req.get('x-admin-password') || ''));
  const real = Buffer.from(String(process.env.ADMIN_PASSWORD || ''));
  return real.length > 0 && given.length === real.length && crypto.timingSafeEqual(given, real);
}
function requireAdmin(req, res, next) {
  if (isAdmin(req)) return next();
  res.status(401).json({ error: 'unauthorized' });
}
const esc = (v, max = 2000) =>
  String(v == null ? '' : v).slice(0, max)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const safeUrl = (v) => (/^https?:\/\//i.test(String(v || '').trim()) ? esc(String(v).trim(), 500) : '');
const STATUSES = ['Pending', 'Under Review', 'Approved', 'Rejected'];
const ID_RE = /^APP-\d{6,20}$/;
const SETTING_KEYS = ['customLogo', 'telegramLink', 'facebookLink'];

const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  console.error(e);
  res.status(500).json({ error: 'server_error' });
});
app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

/* ---------- API ---------- */
app.get('/api/health', wrap(async (req, res) => {
  await (await getDb()).command({ ping: 1 });
  res.json({ ok: true });
}));

app.post('/api/admin/login', (req, res) => {
  if (isAdmin(req)) return res.json({ ok: true });
  res.status(401).json({ error: 'unauthorized' });
});

// Admin: list all applications (oldest first, same order as before)
app.get('/api/applications', requireAdmin, wrap(async (req, res) => {
  const items = await (await getDb()).collection('applications').find({}, { projection: { _id: 0 } }).sort({ id: 1 }).toArray();
  res.json({ items });
}));

// Create (public) or update (admin only) one application
app.put('/api/applications/:id', wrap(async (req, res) => {
  const id = req.params.id;
  if (!ID_RE.test(id)) return res.status(400).json({ error: 'bad_id' });
  const col = (await getDb()).collection('applications');
  const existing = await col.findOne({ id });
  const b = req.body || {};

  if (existing) {
    if (!isAdmin(req)) return res.status(401).json({ error: 'unauthorized' });
    const set = {};
    if (STATUSES.includes(b.status)) set.status = b.status;
    if (typeof b.adminNotes === 'string') set.adminNotes = esc(b.adminNotes, 1000);
    if (Object.keys(set).length) await col.updateOne({ id }, { $set: set });
    return res.json({ ok: true });
  }

  const admin = isAdmin(req);
  await col.insertOne({
    id,
    accountName: esc(b.accountName, 200),
    accountLink: safeUrl(b.accountLink),
    nickname: esc(b.nickname, 100),
    videoLink: safeUrl(b.videoLink),
    position: esc(b.position, 100),
    motivation: esc(b.motivation, 3000),
    date: esc(b.date || new Date().toLocaleString('en-GB'), 100),
    status: admin && STATUSES.includes(b.status) ? b.status : 'Pending',
    adminNotes: admin ? esc(b.adminNotes, 1000) : '',
  });
  res.json({ ok: true });
}));

app.delete('/api/applications/:id', requireAdmin, wrap(async (req, res) => {
  await (await getDb()).collection('applications').deleteOne({ id: req.params.id });
  res.json({ ok: true });
}));

// Settings: public read (logo + social links are shown to everyone), admin write
app.get('/api/settings', wrap(async (req, res) => {
  const rows = await (await getDb()).collection('settings').find({}).toArray();
  const settings = {};
  rows.forEach((r) => { settings[r._id] = r.value; });
  res.json({ settings });
}));

app.put('/api/settings/:key', requireAdmin, wrap(async (req, res) => {
  const key = req.params.key;
  let value = req.body && req.body.value;
  if (!SETTING_KEYS.includes(key)) return res.status(400).json({ error: 'bad_key' });
  if (key === 'customLogo') {
    if (typeof value !== 'string' || !/^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,/i.test(value)) return res.status(400).json({ error: 'bad_image' });
  } else {
    value = String(value || '').trim();
    if (value && !/^https?:\/\//i.test(value)) return res.status(400).json({ error: 'bad_link' });
  }
  await (await getDb()).collection('settings').updateOne({ _id: key }, { $set: { value } }, { upsert: true });
  res.json({ ok: true });
}));

/* ---------- Website ---------- */
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/index.html', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.use((req, res) => res.redirect('/'));

module.exports = app;
if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, '0.0.0.0', () => console.log('Running on port ' + port));
}
