const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const FormData = require('form-data');
const PDFDocument = require('pdfkit');
const { config } = require('./src/config');
const { supabase } = require('./src/db');
const { verifyWebhookSignature: verifyWebhookSignatureModule, shouldProcessInboundMessage: shouldProcessInboundMessageModule } = require('./src/idempotency');
const { handleMessage: handleMessageModule } = require('./src/handlers');
const { sendDocument, sendMessage: sendWhatsAppMessage } = require('./src/whatsapp');
const packageJson = require('./package.json');

const app = express();
app.use(express.json({
  limit: `${Math.max(32, config.MAX_JSON_BODY_KB || 256)}kb`,
  verify: (req, _res, buf) => {
    req.rawBody = buf;
  }
}));
app.use(express.urlencoded({ extended: false, limit: `${Math.max(32, config.MAX_JSON_BODY_KB || 256)}kb` }));

// WhatsApp configuration
const WHATSAPP_TOKEN = config.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = config.PHONE_NUMBER_ID;
const VERIFY_TOKEN = config.VERIFY_TOKEN;
const WHATSAPP_APP_SECRET = config.WHATSAPP_APP_SECRET;
const DEFAULT_TIMEZONE = config.DEFAULT_TIMEZONE;
const SERVER_STARTED_AT = new Date().toISOString();

const ops = {
  webhookOk: 0,
  webhookDenied: 0,
  webhookErrors: 0,
  razorpayOk: 0,
  razorpayDenied: 0,
  razorpayErrors: 0
};

function bump(name) {
  if (!Object.prototype.hasOwnProperty.call(ops, name)) return;
  ops[name] += 1;
}

function clientIp(req) {
  const xff = String(req.get('x-forwarded-for') || '').split(',')[0].trim();
  return xff || req.ip || req.socket?.remoteAddress || 'unknown';
}

const rateWindowMap = new Map();
function createRateLimiter({ label, windowMs, maxRequests }) {
  const cleanEvery = Math.max(1000, Math.floor(windowMs / 2));
  let lastCleanup = 0;
  return (req, res, next) => {
    const now = Date.now();
    if (now - lastCleanup > cleanEvery) {
      for (const [k, v] of rateWindowMap.entries()) {
        if (v.resetAt <= now) rateWindowMap.delete(k);
      }
      lastCleanup = now;
    }
    const ip = clientIp(req);
    const bucketKey = `${label}:${ip}`;
    const existing = rateWindowMap.get(bucketKey);
    if (!existing || existing.resetAt <= now) {
      rateWindowMap.set(bucketKey, { count: 1, resetAt: now + windowMs });
      return next();
    }
    if (existing.count >= maxRequests) {
      res.setHeader('Retry-After', String(Math.ceil((existing.resetAt - now) / 1000)));
      return res.status(429).json({ ok: false, error: 'rate_limited' });
    }
    existing.count += 1;
    return next();
  };
}

const webhookLimiter = createRateLimiter({
  label: 'webhook',
  windowMs: 60 * 1000,
  maxRequests: Math.max(20, config.WEBHOOK_RATE_LIMIT_PER_MIN || 120)
});
const razorpayLimiter = createRateLimiter({
  label: 'razorpay',
  windowMs: 60 * 1000,
  maxRequests: Math.max(10, config.RAZORPAY_RATE_LIMIT_PER_MIN || 60)
});
const trackerWriteLimiter = createRateLimiter({
  label: 'tracker_write',
  windowMs: 60 * 1000,
  maxRequests: Math.max(10, config.TRACKER_WRITE_RATE_LIMIT_PER_MIN || 90)
});

app.use((req, res, next) => {
  const requestId = crypto.randomBytes(6).toString('hex');
  req.requestId = requestId;
  res.setHeader('x-request-id', requestId);
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('permissions-policy', 'geolocation=(), microphone=(), camera=()');
  const start = Date.now();
  if (config.REQUEST_LOGGING) {
    console.log(`[req:start] id=${requestId} ${req.method} ${req.path} ip=${clientIp(req)}`);
  }
  res.on('finish', () => {
    if (!config.REQUEST_LOGGING) return;
    const ms = Date.now() - start;
    console.log(`[req:end] id=${requestId} status=${res.statusCode} ms=${ms}`);
  });
  next();
});

function safeEqual(a, b) {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function withTenant(tenantId, data) {
  if (!config.ENABLE_TENANT_SCOPING || !tenantId) return data;
  return { tenant_id: tenantId, ...data };
}

function userMatch(tenantId, phone) {
  return withTenant(tenantId, { phone });
}

function userPhoneMatch(tenantId, phone) {
  return withTenant(tenantId, { user_phone: phone });
}

function resolveTenantId(req, options = {}) {
  if (!config.ENABLE_TENANT_SCOPING) return null;
  const allowDefault = options.allowDefault !== false;
  const direct = String(req.get('x-tenant-id') || req.query.tenant_id || req.query.tenant || '').trim();
  if (direct) return direct;
  if (!allowDefault) return null;
  return String(config.PHONE_NUMBER_ID || 'default');
}

function verifyWebhookSignature(req) {
  if (process.env.SKIP_WEBHOOK_SIGNATURE === 'true') return true;
  if (!WHATSAPP_APP_SECRET) return false;
  const signature = req.get('x-hub-signature-256');
  if (!signature) return false;
  const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
  const expected = `sha256=${crypto.createHmac('sha256', WHATSAPP_APP_SECRET).update(rawBody).digest('hex')}`;
  return safeEqual(signature, expected);
}

function toBase64Url(buffer) {
  return Buffer.from(buffer)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function signTrackerAccess(phone, tenantId, exp) {
  const secret = config.TRACKER_SHARE_SECRET;
  if (!secret) return '';
  const payload = `${phone}|${tenantId || ''}|${exp}`;
  return toBase64Url(crypto.createHmac('sha256', secret).update(payload).digest());
}

function verifyTrackerAccess(phone, tenantId, exp, sig) {
  if (!config.TRACKER_SHARE_SECRET) return false;
  const expected = signTrackerAccess(phone, tenantId, exp);
  return safeEqual(expected, sig || '');
}

function maskPhone(phone) {
  const p = String(phone || '');
  if (p.length <= 4) return '****';
  return `${'*'.repeat(Math.max(0, p.length - 4))}${p.slice(-4)}`;
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function normalizeTheme(value) {
  const t = String(value || '').trim().toLowerCase();
  if (t === 'ocean') return 'ocean';
  if (t === 'forest') return 'forest';
  return 'sunrise';
}

function isIsoMonth(value) {
  const m = String(value || '').trim();
  return /^\d{4}-\d{2}$/.test(m);
}

function monthDaysList(month) {
  if (!isIsoMonth(month)) return [];
  const year = parseInt(month.slice(0, 4), 10);
  const mon = parseInt(month.slice(5, 7), 10);
  if (!Number.isInteger(year) || !Number.isInteger(mon) || mon < 1 || mon > 12) return [];
  const start = new Date(Date.UTC(year, mon - 1, 1));
  const out = [];
  while (start.getUTCMonth() === mon - 1) {
    out.push(start.toISOString().slice(0, 10));
    start.setUTCDate(start.getUTCDate() + 1);
  }
  return out;
}

function monthBoundsIso(month) {
  if (!isIsoMonth(month)) return null;
  const year = parseInt(month.slice(0, 4), 10);
  const mon = parseInt(month.slice(5, 7), 10);
  if (!Number.isInteger(year) || !Number.isInteger(mon) || mon < 1 || mon > 12) return null;
  const start = new Date(Date.UTC(year, mon - 1, 1));
  const end = new Date(Date.UTC(year, mon, 1));
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

function trackerAuthFromRequest(req) {
  const fromBody = req.body && typeof req.body === 'object' ? req.body : {};
  const phone = String(req.query.phone || fromBody.phone || '').trim();
  const tenantId = config.ENABLE_TENANT_SCOPING
    ? String(req.query.tenant || fromBody.tenant || '').trim()
    : null;
  const expRaw = req.query.exp ?? fromBody.exp;
  const exp = parseInt(String(expRaw || ''), 10);
  const sig = String(req.query.sig || fromBody.sig || '').trim();
  return { phone, tenantId, exp, sig };
}

function validateTrackerAuth({ phone, tenantId, exp, sig }) {
  if (!phone) return { ok: false, code: 400, message: 'Missing phone' };
  const allowInsecure = config.ALLOW_INSECURE_TRACKER === true;
  if (config.ENABLE_TENANT_SCOPING && !tenantId) return { ok: false, code: 400, message: 'Missing tenant' };
  if (allowInsecure) return { ok: true };
  if (!config.TRACKER_SHARE_SECRET) return { ok: false, code: 503, message: 'Tracker access is not configured' };
  if (!sig || !Number.isInteger(exp)) return { ok: false, code: 401, message: 'Missing tracker signature' };
  const nowSec = Math.floor(Date.now() / 1000);
  if (exp < nowSec || exp > nowSec + (7 * 24 * 60 * 60)) return { ok: false, code: 401, message: 'Tracker link expired' };
  if (!verifyTrackerAccess(phone, tenantId, exp, sig)) return { ok: false, code: 401, message: 'Invalid tracker signature' };
  return { ok: true };
}

function isProActiveUser(user) {
  if (!user || user.is_pro !== true) return false;
  if (!user.pro_expires_at) return true;
  const t = Date.parse(user.pro_expires_at);
  return Number.isFinite(t) && t > Date.now();
}

async function logConsentEvent(userPhone, tenantId, eventType, details = {}) {
  try {
    if (!userPhone || !eventType) return;
    const payload = withTenant(tenantId, {
      user_phone: userPhone,
      event_type: eventType,
      details,
      created_at: new Date().toISOString()
    });
    const { error } = await supabase.from('consent_events').insert(payload);
    if (error && !/consent_events/i.test(error.message || '')) {
      console.error('consent_events insert failed:', error.message);
    }
  } catch (_) {
  }
}

function phoneCandidates(rawPhone) {
  const digits = String(rawPhone || '').replace(/\D/g, '');
  if (!digits) return [];
  const out = new Set([digits]);
  if (digits.startsWith('91') && digits.length === 12) out.add(digits.slice(2));
  if (digits.length === 10) out.add(`91${digits}`);
  if (digits.startsWith('0') && digits.length > 10) out.add(digits.replace(/^0+/, ''));
  return Array.from(out).filter(Boolean);
}

async function resolveExistingUserPhone(rawPhone, tenantId) {
  const candidates = phoneCandidates(rawPhone);
  if (!candidates.length) return '';
  const match = withTenant(tenantId, {});
  const { data, error } = await supabase
    .from('users')
    .select('phone')
    .match(match)
    .in('phone', candidates)
    .limit(1);
  if (error) {
    console.error('users lookup by phone failed:', error.message);
    return '';
  }
  return Array.isArray(data) && data[0]?.phone ? String(data[0].phone) : '';
}

async function claimPaymentEvent(eventKey, tenantId) {
  if (!eventKey) return { ok: false, reason: 'missing_event_key' };
  const row = withTenant(tenantId, { event_key: eventKey });
  try {
    const { error } = await supabase.from('processed_payment_events').insert(row);
    if (!error) return { ok: true };
    if (String(error.code) === '23505') return { ok: false, reason: 'duplicate' };
    if (/processed_payment_events|event_key/i.test(error.message || '')) {
      return { ok: false, reason: 'schema_missing' };
    }
    return { ok: false, reason: 'db_error', error };
  } catch (e) {
    return { ok: false, reason: 'exception', error: e };
  }
}

async function releasePaymentEvent(eventKey, tenantId) {
  if (!eventKey) return;
  try {
    await supabase
      .from('processed_payment_events')
      .delete()
      .match(withTenant(tenantId, { event_key: eventKey }));
  } catch (_) {
  }
}

async function findPaymentLogByEventKey(eventKey, tenantId) {
  if (!eventKey) return null;
  try {
    const { data, error } = await supabase
      .from('subscription_payments')
      .select('id,event_key,payment_id,status,plan_code,plan_days,paid_at')
      .match(withTenant(tenantId, { event_key: eventKey }))
      .limit(1);
    if (error) {
      if (/subscription_payments/i.test(error.message || '')) return null;
      console.error('subscription_payments by event_key lookup failed:', error.message);
      return null;
    }
    return Array.isArray(data) && data.length ? data[0] : null;
  } catch (_) {
    return null;
  }
}

async function findPaymentLogByPaymentId(paymentId, tenantId) {
  if (!paymentId) return null;
  try {
    const { data, error } = await supabase
      .from('subscription_payments')
      .select('id,event_key,payment_id,status,plan_code,plan_days,paid_at')
      .match(withTenant(tenantId, { payment_id: paymentId }))
      .limit(1);
    if (error) {
      if (/subscription_payments/i.test(error.message || '')) return null;
      console.error('subscription_payments by payment_id lookup failed:', error.message);
      return null;
    }
    return Array.isArray(data) && data.length ? data[0] : null;
  } catch (_) {
    return null;
  }
}

function parsePositiveInt(value, fallback, min = 1, max = 3650) {
  const n = parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function normalizePlanCode(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, '_');
}

function inferPlanCode(notes, amountPaise) {
  const explicit = normalizePlanCode(notes?.plan || notes?.plan_code || notes?.tier);
  if (explicit) return explicit;
  if (amountPaise === 19900) return 'parent_basic_199';
  if (amountPaise === 49900) return 'pro_plus_499';
  return 'pro_generic';
}

function nowPartsInTimeZone(timeZone) {
  const tz = timeZone || DEFAULT_TIMEZONE;
  const now = new Date();
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  return { today, month: today.slice(0, 7), timeZone: tz };
}

async function getUserTimeZone(userPhone, tenantId) {
  try {
    const match = tenantId ? { tenant_id: tenantId, phone: userPhone } : { phone: userPhone };
    const { data: u } = await supabase.from('users').select('*').match(match).single();
    return (u && typeof u.timezone === 'string' && u.timezone) ? u.timezone : DEFAULT_TIMEZONE;
  } catch (_) {
    return DEFAULT_TIMEZONE;
  }
}

function lastNDatesFromToday(todayStr, n) {
  const base = new Date(`${todayStr}T00:00:00Z`);
  const out = [];
  for (let i = 0; i <= n; i++) {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function buildChartConfig(attended, cancelled, remaining) {
  return {
    type: 'doughnut',
    data: {
      labels: ['Attended', 'Missed', 'Remaining'],
      datasets: [{
        data: [attended, cancelled, Math.max(0, remaining)],
        backgroundColor: ['#22c55e', '#ef4444', '#3b82f6']
      }]
    },
    options: {
      plugins: { legend: { display: true, position: 'bottom' } },
      cutout: '60%'
    }
  };
}

function buildMonthlyStats(configRow, sessions) {
  const list = Array.isArray(sessions) ? sessions : [];
  const attended = list.filter(s => s.status === 'attended').length;
  const cancelled = list.filter(s => s.status === 'cancelled').length;
  const totalSessions = (configRow.paid_sessions || 0) + (configRow.carry_forward || 0);
  const remaining = totalSessions - attended;
  const amountUsed = Math.max(0, Math.min(attended, configRow.paid_sessions || 0)) * (configRow.cost_per_session || 0);
  const amountCancelled = Math.max(0, Math.min(cancelled, Math.max((configRow.paid_sessions || 0) - Math.min(attended, configRow.paid_sessions || 0), 0))) * (configRow.cost_per_session || 0);
  const bufferSessions = Math.max(0, totalSessions - attended - cancelled);
  const bufferValue = bufferSessions * (configRow.cost_per_session || 0);
  return { attended, cancelled, remaining, amountUsed, amountCancelled, bufferValue, totalSessions };
}

async function buildMonthlyReportPdf({ phone, month, monthName, stats, chartBuffer, configRow }) {
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  const chunks = [];
  const done = new Promise((resolve, reject) => {
    doc.on('end', resolve);
    doc.on('error', reject);
  });
  doc.on('data', (c) => chunks.push(c));
  doc.fontSize(20).text(`Therapy Tracker â€¢ ${monthName} Summary`);
  doc.moveDown(0.5);
  doc.fontSize(11).text(`Phone: ${phone}`);
  doc.fontSize(11).text(`Month: ${month}`);
  doc.moveDown();
  const chartWidth = 360;
  const x = (doc.page.width - chartWidth) / 2;
  doc.image(chartBuffer, x, doc.y, { width: chartWidth });
  doc.moveDown(12);
  doc.fontSize(14).text('Payment');
  doc.fontSize(11).text(`Paid sessions: ${configRow.paid_sessions || 0}`);
  doc.fontSize(11).text(`Carry forward: ${configRow.carry_forward || 0}`);
  doc.fontSize(11).text(`Rate: â‚¹${configRow.cost_per_session || 0}/session`);
  doc.fontSize(11).text(`Total paid: â‚¹${(configRow.paid_sessions || 0) * (configRow.cost_per_session || 0)}`);
  doc.moveDown();
  doc.fontSize(14).text('Attendance');
  doc.fontSize(11).text(`Attended: ${stats.attended} (â‚¹${stats.amountUsed})`);
  doc.fontSize(11).text(`Missed: ${stats.cancelled} (â‚¹${stats.amountCancelled})`);
  doc.fontSize(11).text(`Remaining: ${Math.max(0, stats.remaining)} sessions`);
  doc.moveDown();
  doc.fontSize(14).text('Cost Breakdown');
  doc.fontSize(11).text(`Used: â‚¹${stats.amountUsed}`);
  doc.fontSize(11).text(`Buffer: â‚¹${stats.bufferValue}`);
  doc.end();
  await done;
  return Buffer.concat(chunks);
}

app.get('/internal/monthly-report', async (req, res) => {
  try {
    const token = req.get('x-internal-token') || req.query.token;
    if (!config.INTERNAL_REPORT_TOKEN || token !== config.INTERNAL_REPORT_TOKEN) {
      res.sendStatus(401);
      return;
    }
    const tenantId = resolveTenantId(req, { allowDefault: false });
    if (config.ENABLE_TENANT_SCOPING && !tenantId) {
      res.status(400).json({ ok: false, error: 'Missing tenant_id' });
      return;
    }
    let users = [];
    let error = null;
    ({ data: users, error } = await supabase
      .from('users')
      .select('phone,timezone,is_pro,pro_expires_at')
      .match(withTenant(tenantId, {})));
    if (error && /is_pro|pro_expires_at/i.test(error.message || '')) {
      res.status(409).json({ ok: false, error: 'users.is_pro/users.pro_expires_at missing. Run database_hardening.sql.' });
      return;
    }
    if (error) {
      console.error('Supabase users select error:', error.message);
      res.status(500).json({ ok: false, error: 'db' });
      return;
    }
    let sent = 0;
    let skipped = 0;
    for (const user of (users || []).filter((u) => isProActiveUser(u))) {
      const phone = user?.phone;
      if (!phone) {
        skipped += 1;
        continue;
      }
      const tz = user?.timezone || DEFAULT_TIMEZONE;
      const { month } = nowPartsInTimeZone(tz);
      const { data: configRow } = await supabase
        .from('monthly_config')
        .select('*')
        .match(userPhoneMatch(tenantId, phone))
        .eq('month', month)
        .single();
      if (!configRow) {
        skipped += 1;
        continue;
      }
      const { data: sessions } = await supabase
        .from('sessions')
        .select('*')
        .match(userPhoneMatch(tenantId, phone))
        .eq('month', month);
      const stats = buildMonthlyStats(configRow, sessions);
      const dt = new Date(month + '-01');
      const monthName = dt.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }).toUpperCase();
      const chartConfig = buildChartConfig(stats.attended, stats.cancelled, stats.remaining);
      const chartUrl = `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(chartConfig))}`;
      const chartRes = await axios.get(chartUrl, { responseType: 'arraybuffer' });
      const chartBuffer = Buffer.from(chartRes.data);
      const pdfBuffer = await buildMonthlyReportPdf({
        phone,
        month,
        monthName,
        stats,
        chartBuffer,
        configRow
      });
      const filename = `Therapy-Report-${month}.pdf`;
      await sendDocument(phone, pdfBuffer, filename, `${monthName} Summary`);
      sent += 1;
    }
    res.status(200).json({ ok: true, sent, skipped });
  } catch (e) {
    console.error('monthly-report error:', e.message);
    res.status(500).json({ ok: false });
  }
});

app.get('/internal/tracker-link', async (req, res) => {
  try {
    const token = req.get('x-internal-token') || req.query.token;
    if (!config.INTERNAL_REPORT_TOKEN || token !== config.INTERNAL_REPORT_TOKEN) {
      res.sendStatus(401);
      return;
    }
    if (!config.TRACKER_SHARE_SECRET) {
      res.status(500).json({ ok: false, error: 'TRACKER_SHARE_SECRET not configured' });
      return;
    }
    const phone = String(req.query.phone || '').trim();
    if (!phone) {
      res.status(400).json({ ok: false, error: 'Missing phone' });
      return;
    }
    const tenantId = resolveTenantId(req, { allowDefault: false });
    if (config.ENABLE_TENANT_SCOPING && !tenantId) {
      res.status(400).json({ ok: false, error: 'Missing tenant_id' });
      return;
    }
    const requestedTtl = parseInt(String(req.query.ttl_sec || config.TRACKER_LINK_TTL_SEC || 900), 10);
    const ttlSec = Number.isInteger(requestedTtl) ? Math.max(60, Math.min(requestedTtl, 7 * 24 * 60 * 60)) : 900;
    const theme = normalizeTheme(req.query.theme);
    const exp = Math.floor(Date.now() / 1000) + ttlSec;
    const sig = signTrackerAccess(phone, tenantId, exp);
    const params = new URLSearchParams({
      phone,
      exp: String(exp),
      sig
    });
    if (tenantId) params.set('tenant', tenantId);
    params.set('theme', theme);
    const host = req.get('host');
    const baseUrl = `${req.protocol}://${host}`;
    const expiresAt = new Date(exp * 1000).toISOString();
    await logConsentEvent(phone, tenantId, 'share_link_generated', {
      ttl_sec: ttlSec,
      expires_at: expiresAt,
      theme
    });
    res.status(200).json({
      ok: true,
      url: `${baseUrl}/mytracker?${params.toString()}`,
      expires_at: expiresAt,
      theme
    });
  } catch (e) {
    console.error('tracker-link error:', e.message);
    res.status(500).json({ ok: false });
  }
});

app.get('/mytracker', async (req, res) => {
  try {
    const auth = trackerAuthFromRequest(req);
    const valid = validateTrackerAuth(auth);
    if (!valid.ok) {
      res.status(valid.code).send(valid.message);
      return;
    }
    const { phone, tenantId } = auth;
    await logConsentEvent(phone, tenantId, 'share_link_opened', { path: '/mytracker' });

    const tz = await getUserTimeZone(phone, tenantId);
    const nowMonth = nowPartsInTimeZone(tz).month;
    const month = isIsoMonth(req.query.month) ? String(req.query.month) : nowMonth;
    const userFields = 'theme,locale';
    let userRow = null;
    try {
      const { data } = await supabase.from('users').select(userFields).match(userMatch(tenantId, phone)).single();
      userRow = data || null;
    } catch (_) {
      userRow = null;
    }
    const theme = normalizeTheme(req.query.theme || userRow?.theme || 'sunrise');

    const { data: configRow } = await supabase
      .from('monthly_config')
      .select('*')
      .match(userPhoneMatch(tenantId, phone))
      .eq('month', month)
      .single();
    if (!configRow) {
      res.status(404).send('No config for this month');
      return;
    }

    const [sessionsRes, holidaysRes] = await Promise.all([
      supabase.from('sessions').select('date,status,reason').match(userPhoneMatch(tenantId, phone)).eq('month', month),
      supabase.from('holidays').select('date').match(userPhoneMatch(tenantId, phone)).eq('month', month)
    ]);
    const sessions = Array.isArray(sessionsRes.data) ? sessionsRes.data : [];
    const holidays = Array.isArray(holidaysRes.data) ? holidaysRes.data : [];

    const attended = sessions.filter((s) => s.status === 'attended').length;
    const cancelled = sessions.filter((s) => s.status === 'cancelled').length;
    const totalSessions = (configRow.paid_sessions || 0) + (configRow.carry_forward || 0);
    const remaining = Math.max(0, totalSessions - attended);
    const days = monthDaysList(month);
    const statusByDate = {};
    for (const d of days) statusByDate[d] = 'none';
    for (const h of holidays) {
      const d = String(h.date || '').slice(0, 10);
      if (statusByDate[d] !== undefined) statusByDate[d] = 'holiday';
    }
    for (const s of sessions) {
      const d = String(s.date || '').slice(0, 10);
      if (statusByDate[d] === undefined) continue;
      if (s.status === 'attended') statusByDate[d] = 'attended';
      else if (s.status === 'cancelled' && statusByDate[d] !== 'attended') statusByDate[d] = 'missed';
    }

    const themes = {
      sunrise: {
        bg: 'linear-gradient(145deg,#fef6e4 0%,#f9e2c2 45%,#f5d0a9 100%)',
        card: '#fffef8',
        ink: '#1f2937',
        muted: '#6b7280',
        accent: '#f97316',
        accentSoft: '#fed7aa'
      },
      ocean: {
        bg: 'linear-gradient(145deg,#e6f7ff 0%,#d2f1ff 45%,#b9e6ff 100%)',
        card: '#f8fdff',
        ink: '#0f172a',
        muted: '#475569',
        accent: '#0284c7',
        accentSoft: '#bae6fd'
      },
      forest: {
        bg: 'linear-gradient(145deg,#edf7ed 0%,#d9f0dc 45%,#c4e8cf 100%)',
        card: '#f7fdf8',
        ink: '#1a2e22',
        muted: '#4b6355',
        accent: '#15803d',
        accentSoft: '#bbf7d0'
      }
    };
    const palette = themes[theme] || themes.sunrise;
    const safePhone = escapeHtml(phone);
    const monthLabel = new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
    const authPayload = {
      phone,
      tenant: tenantId || '',
      exp: Number.isInteger(auth.exp) ? auth.exp : '',
      sig: auth.sig || '',
      theme
    };
    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Therapy Tracker Calendar</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Sora:wght@400;600;700;800&family=Manrope:wght@400;600;700&display=swap" rel="stylesheet">
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    :root {
      --bg: ${palette.bg};
      --card: ${palette.card};
      --ink: ${palette.ink};
      --muted: ${palette.muted};
      --accent: ${palette.accent};
      --accent-soft: ${palette.accentSoft};
      --good: #16a34a;
      --miss: #dc2626;
      --holiday: #d97706;
      --none: #cbd5e1;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: 'Manrope', sans-serif;
      color: var(--ink);
      background: var(--bg);
      padding: 18px;
    }
    .wrap { max-width: 1080px; margin: 0 auto; display: grid; gap: 16px; }
    .hero {
      background: var(--card);
      border-radius: 18px;
      border: 1px solid rgba(15, 23, 42, 0.08);
      padding: 16px;
      box-shadow: 0 8px 30px rgba(0,0,0,0.06);
    }
    .title {
      margin: 0;
      font-family: 'Sora', sans-serif;
      font-weight: 800;
      letter-spacing: 0.2px;
      font-size: clamp(22px, 3.2vw, 34px);
    }
    .meta { color: var(--muted); margin-top: 4px; font-size: 14px; }
    .toolbar {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-top: 12px;
      align-items: center;
    }
    .pill {
      border: 1px solid rgba(15, 23, 42, 0.12);
      background: #fff;
      color: var(--ink);
      border-radius: 12px;
      padding: 8px 10px;
      font-size: 13px;
      font-weight: 700;
      cursor: pointer;
    }
    .pill.primary {
      background: var(--accent);
      color: #fff;
      border-color: transparent;
    }
    .grid {
      display: grid;
      grid-template-columns: 1.1fr 1fr;
      gap: 16px;
    }
    .card {
      background: var(--card);
      border-radius: 18px;
      border: 1px solid rgba(15, 23, 42, 0.08);
      padding: 14px;
      box-shadow: 0 8px 30px rgba(0,0,0,0.05);
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
      margin-bottom: 12px;
    }
    .stat {
      background: #fff;
      border-radius: 12px;
      border: 1px solid rgba(15, 23, 42, 0.09);
      padding: 10px;
      text-align: center;
    }
    .stat strong {
      display: block;
      font-size: 23px;
      font-family: 'Sora', sans-serif;
    }
    .legend { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; font-size: 12px; color: var(--muted); }
    .legend span { display: inline-flex; align-items: center; gap: 6px; }
    .dot { width: 10px; height: 10px; border-radius: 999px; display: inline-block; }
    .calendar-head, .calendar {
      display: grid;
      grid-template-columns: repeat(7, minmax(0, 1fr));
      gap: 8px;
    }
    .calendar-head div {
      text-align: center;
      font-size: 12px;
      color: var(--muted);
      font-weight: 700;
      padding-bottom: 4px;
    }
    .day {
      border: 1px solid rgba(15, 23, 42, 0.12);
      border-radius: 12px;
      background: #fff;
      min-height: 48px;
      font-size: 14px;
      font-weight: 700;
      cursor: pointer;
      display: flex;
      justify-content: center;
      align-items: center;
      transition: transform .12s ease, box-shadow .12s ease, border-color .12s ease;
    }
    .day:hover { transform: translateY(-1px); box-shadow: 0 5px 14px rgba(0,0,0,0.08); }
    .day.none { border-color: rgba(100, 116, 139, 0.25); color: #64748b; }
    .day.attended { border-color: rgba(22, 163, 74, 0.3); background: rgba(22, 163, 74, 0.12); color: #166534; }
    .day.missed { border-color: rgba(220, 38, 38, 0.3); background: rgba(220, 38, 38, 0.11); color: #991b1b; }
    .day.holiday { border-color: rgba(217, 119, 6, 0.3); background: rgba(217, 119, 6, 0.14); color: #92400e; }
    .status-line { margin-top: 8px; color: var(--muted); font-size: 13px; }
    .section-title { margin: 0 0 10px 0; font-size: 16px; font-family: 'Sora', sans-serif; }
    .note { font-size: 12px; color: var(--muted); margin-top: 6px; }
    canvas { max-width: 340px; margin: 0 auto; display: block; }
    @media (max-width: 880px) { .grid { grid-template-columns: 1fr; } .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  </style>
</head>
<body>
  <div class="wrap">
    <section class="hero">
      <h1 class="title">Therapy Tracker Calendar</h1>
      <div class="meta">${safePhone} Â· ${escapeHtml(monthLabel)}</div>
      <div class="toolbar">
        <select id="themeSelect" class="pill">
          <option value="sunrise"${theme === 'sunrise' ? ' selected' : ''}>Sunrise</option>
          <option value="ocean"${theme === 'ocean' ? ' selected' : ''}>Ocean</option>
          <option value="forest"${theme === 'forest' ? ' selected' : ''}>Forest</option>
        </select>
        <button id="saveBtn" class="pill primary">Save calendar changes</button>
        <button id="resetBtn" class="pill">Reset this month</button>
      </div>
      <div id="saveStatus" class="status-line">Tap date to cycle: none â†’ attended â†’ missed â†’ holiday.</div>
    </section>
    <section class="grid">
      <div class="card">
        <h2 class="section-title">Tap Calendar</h2>
        <div class="legend">
          <span><i class="dot" style="background:var(--none)"></i>None</span>
          <span><i class="dot" style="background:var(--good)"></i>Attended</span>
          <span><i class="dot" style="background:var(--miss)"></i>Missed</span>
          <span><i class="dot" style="background:var(--holiday)"></i>Holiday</span>
        </div>
        <div class="calendar-head">
          <div>Mon</div><div>Tue</div><div>Wed</div><div>Thu</div><div>Fri</div><div>Sat</div><div>Sun</div>
        </div>
        <div id="calendar" class="calendar"></div>
        <div class="note">Changes are secure and tied to this signed tracker link.</div>
      </div>
      <div class="card">
        <h2 class="section-title">Month Snapshot</h2>
        <div class="stats">
          <div class="stat"><div>Attended</div><strong id="attendedCount">${attended}</strong></div>
          <div class="stat"><div>Missed</div><strong id="missedCount">${cancelled}</strong></div>
          <div class="stat"><div>Remaining</div><strong id="remainingCount">${remaining}</strong></div>
        </div>
        <canvas id="chart" width="400" height="300"></canvas>
      </div>
    </section>
  </div>
  <script>
    const AUTH = ${JSON.stringify(authPayload)};
    const CURRENT_MONTH = ${JSON.stringify(month)};
    const MONTH_DAYS = ${JSON.stringify(days)};
    const ORIGINAL = ${JSON.stringify(statusByDate)};
    const state = { ...ORIGINAL };
    const order = ['none', 'attended', 'missed', 'holiday'];
    const calendarEl = document.getElementById('calendar');
    const saveStatus = document.getElementById('saveStatus');
    const attendedCountEl = document.getElementById('attendedCount');
    const missedCountEl = document.getElementById('missedCount');
    const remainingCountEl = document.getElementById('remainingCount');
    const totalSessions = ${JSON.stringify(totalSessions)};
    let chartRef = null;

    function weekdayIndex(dateStr) {
      const d = new Date(dateStr + 'T00:00:00Z');
      const w = d.getUTCDay();
      return w === 0 ? 6 : w - 1;
    }

    function nextStatus(current) {
      const i = order.indexOf(current);
      return order[(i + 1) % order.length];
    }

    function computeMetrics() {
      const vals = Object.values(state);
      const attended = vals.filter(v => v === 'attended').length;
      const missed = vals.filter(v => v === 'missed').length;
      const remaining = Math.max(0, totalSessions - attended);
      return { attended, missed, remaining };
    }

    function countChanges() {
      return MONTH_DAYS.reduce((acc, d) => acc + (state[d] !== ORIGINAL[d] ? 1 : 0), 0);
    }

    function renderChart() {
      const m = computeMetrics();
      attendedCountEl.textContent = String(m.attended);
      missedCountEl.textContent = String(m.missed);
      remainingCountEl.textContent = String(m.remaining);
      const ctx = document.getElementById('chart').getContext('2d');
      if (chartRef) chartRef.destroy();
      chartRef = new Chart(ctx, {
        type: 'doughnut',
        data: {
          labels: ['Attended', 'Missed', 'Remaining'],
          datasets: [{ data: [m.attended, m.missed, m.remaining], backgroundColor: ['#16a34a','#dc2626','#2563eb'] }]
        },
        options: { plugins: { legend: { position: 'bottom' } }, cutout: '62%' }
      });
    }

    function renderCalendar() {
      calendarEl.innerHTML = '';
      const offset = weekdayIndex(MONTH_DAYS[0]);
      for (let i = 0; i < offset; i++) {
        const spacer = document.createElement('div');
        spacer.style.visibility = 'hidden';
        calendarEl.appendChild(spacer);
      }
      for (const date of MONTH_DAYS) {
        const btn = document.createElement('button');
        btn.className = 'day ' + (state[date] || 'none');
        btn.type = 'button';
        btn.dataset.date = date;
        btn.textContent = String(parseInt(date.slice(8, 10), 10));
        btn.addEventListener('click', () => {
          state[date] = nextStatus(state[date] || 'none');
          renderCalendar();
          renderChart();
          const n = countChanges();
          saveStatus.textContent = n ? (n + ' day(s) changed. Click Save calendar changes.') : 'No unsaved changes.';
        });
        calendarEl.appendChild(btn);
      }
    }

    async function saveChanges() {
      const changes = MONTH_DAYS
        .filter((d) => state[d] !== ORIGINAL[d])
        .map((d) => ({ date: d, status: state[d] }));
      if (!changes.length) {
        saveStatus.textContent = 'No changes to save.';
        return;
      }
      saveStatus.textContent = 'Saving...';
      const payload = {
        phone: AUTH.phone,
        tenant: AUTH.tenant,
        exp: AUTH.exp,
        sig: AUTH.sig,
        month: CURRENT_MONTH,
        changes
      };
      try {
        const r = await fetch('/mytracker/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await r.json();
        if (!r.ok || !data.ok) throw new Error(data.error || 'Save failed');
        for (const c of changes) ORIGINAL[c.date] = c.status;
        saveStatus.textContent = 'Saved. Updated: ' + (data.updated || 0) + ' day(s).';
      } catch (e) {
        saveStatus.textContent = 'Save failed: ' + e.message;
      }
    }

    async function resetMonth() {
      if (!confirm('Reset this month? This clears logs, notes, holidays and setup for this month.')) return;
      saveStatus.textContent = 'Resetting month...';
      try {
        const r = await fetch('/mytracker/reset-month', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            phone: AUTH.phone,
            tenant: AUTH.tenant,
            exp: AUTH.exp,
            sig: AUTH.sig,
            month: CURRENT_MONTH
          })
        });
        const data = await r.json();
        if (!r.ok || !data.ok) throw new Error(data.error || 'Reset failed');
        location.reload();
      } catch (e) {
        saveStatus.textContent = 'Reset failed: ' + e.message;
      }
    }

    document.getElementById('saveBtn').addEventListener('click', saveChanges);
    document.getElementById('resetBtn').addEventListener('click', resetMonth);
    document.getElementById('themeSelect').addEventListener('change', (e) => {
      const url = new URL(location.href);
      url.searchParams.set('theme', e.target.value);
      location.href = url.toString();
    });

    renderCalendar();
    renderChart();
  </script>
</body>
</html>`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(html);
  } catch (e) {
    console.error('Error rendering /mytracker:', e.message);
    res.status(500).send('Something went wrong');
  }
});

app.post('/mytracker/save', trackerWriteLimiter, async (req, res) => {
  try {
    const auth = trackerAuthFromRequest(req);
    const valid = validateTrackerAuth(auth);
    if (!valid.ok) {
      res.status(valid.code).json({ ok: false, error: valid.message });
      return;
    }
    const { phone, tenantId } = auth;
    const month = String(req.body?.month || '').trim();
    if (!isIsoMonth(month)) {
      res.status(400).json({ ok: false, error: 'Invalid month' });
      return;
    }
    const allowedDates = new Set(monthDaysList(month));
    const raw = Array.isArray(req.body?.changes) ? req.body.changes : [];
    if (raw.length > 62) {
      res.status(400).json({ ok: false, error: 'Too many changes' });
      return;
    }
    const allowedStatus = new Set(['attended', 'missed', 'holiday', 'none', 'clear']);
    let updated = 0;
    for (const row of raw) {
      const date = String(row?.date || '').slice(0, 10);
      const status = String(row?.status || '').trim().toLowerCase();
      if (!allowedDates.has(date)) continue;
      if (!allowedStatus.has(status)) continue;
      const scope = userPhoneMatch(tenantId, phone);
      if (status === 'none' || status === 'clear') {
        await supabase.from('sessions').delete().match(scope).eq('date', date);
        await supabase.from('holidays').delete().match(scope).eq('date', date);
        updated += 1;
        continue;
      }
      if (status === 'holiday') {
        await supabase.from('sessions').delete().match(scope).eq('date', date);
        const holidayRow = withTenant(tenantId, { user_phone: phone, date, month });
        const holidayConflict = (config.ENABLE_TENANT_SCOPING && tenantId) ? 'tenant_id,user_phone,date' : 'user_phone,date';
        const { error } = await supabase.from('holidays').upsert([holidayRow], { onConflict: holidayConflict });
        if (error) {
          await supabase.from('holidays').delete().match(scope).eq('date', date);
          await supabase.from('holidays').insert(holidayRow);
        }
        updated += 1;
        continue;
      }
      await supabase.from('holidays').delete().match(scope).eq('date', date);
      await supabase.from('sessions').delete().match(scope).eq('date', date);
      const sessionRow = withTenant(tenantId, {
        user_phone: phone,
        date,
        month,
        status: status === 'missed' ? 'cancelled' : 'attended',
        ...(status === 'missed' ? { reason: 'Marked from web calendar' } : {})
      });
      await supabase.from('sessions').insert(sessionRow);
      updated += 1;
    }
    await logConsentEvent(phone, tenantId, 'calendar_web_update', { month, updated });
    res.status(200).json({ ok: true, updated });
  } catch (e) {
    console.error('mytracker save error:', e.message);
    res.status(500).json({ ok: false, error: 'save_failed' });
  }
});

app.post('/mytracker/reset-month', trackerWriteLimiter, async (req, res) => {
  try {
    const auth = trackerAuthFromRequest(req);
    const valid = validateTrackerAuth(auth);
    if (!valid.ok) {
      res.status(valid.code).json({ ok: false, error: valid.message });
      return;
    }
    const { phone, tenantId } = auth;
    const month = String(req.body?.month || '').trim();
    if (!isIsoMonth(month)) {
      res.status(400).json({ ok: false, error: 'Invalid month' });
      return;
    }
    const scope = userPhoneMatch(tenantId, phone);
    await supabase.from('sessions').delete().match(scope).eq('month', month);
    await supabase.from('holidays').delete().match(scope).eq('month', month);
    await supabase.from('monthly_config').delete().match(scope).eq('month', month);
    const bounds = monthBoundsIso(month);
    if (bounds) {
      await supabase
        .from('feedback_notes')
        .delete()
        .match(scope)
        .gte('created_at', bounds.startIso)
        .lt('created_at', bounds.endIso);
    }
    await logConsentEvent(phone, tenantId, 'calendar_web_reset', { month });
    res.status(200).json({ ok: true, month });
  } catch (e) {
    console.error('mytracker reset error:', e.message);
    res.status(500).json({ ok: false, error: 'reset_failed' });
  }
});

async function fetchMediaInfo(mediaId) {
  const { data } = await axios.get(`https://graph.facebook.com/v18.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }
  });
  return data || {};
}

async function downloadMediaBuffer(mediaId) {
  const info = await fetchMediaInfo(mediaId);
  const url = info?.url;
  if (!url) return { buffer: Buffer.alloc(0), mimeType: info?.mime_type };
  const mediaRes = await axios.get(url, {
    responseType: 'arraybuffer',
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }
  });
  return { buffer: Buffer.from(mediaRes.data || []), mimeType: info?.mime_type };
}

async function transcribeWithGroq(buffer, mimeType) {
  const key = config.GROQ_API_KEY;
  if (!key) return '';
  try {
    const form = new FormData();
    form.append('file', buffer, { filename: 'audio', contentType: mimeType || 'audio/ogg' });
    form.append('model', 'whisper-large-v3');
    const { data } = await axios.post(
      'https://api.groq.com/openai/v1/audio/transcriptions',
      form,
      { headers: { Authorization: `Bearer ${key}`, ...form.getHeaders() } }
    );
    return (data && data.text) ? String(data.text) : '';
  } catch (_) {
    return '';
  }
}

async function transcribeWithSarvam(buffer, mimeType) {
  const key = config.SARVAM_API_KEY;
  if (!key) return '';
  try {
    const form = new FormData();
    form.append('file', buffer, { filename: 'audio', contentType: mimeType || 'audio/ogg' });
    const { data } = await axios.post(
      'https://api.sarvam.ai/speech-to-text',
      form,
      { headers: { 'api-subscription-key': key, ...form.getHeaders() } }
    );
    if (data && typeof data.transcript === 'string') return data.transcript.trim();
    if (data && typeof data.text === 'string') return data.text.trim();
    return '';
  } catch (_) {
    return '';
  }
}

async function transcribeAudio(buffer, mimeType) {
  if (!buffer || !buffer.length) return '';
  if (config.USE_SARVAM) return await transcribeWithSarvam(buffer, mimeType);
  return await transcribeWithGroq(buffer, mimeType);
}

// Webhook verification (required by Meta)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verified successfully!');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Receive messages
app.post('/webhook', webhookLimiter, async (req, res) => {
  try {
    if (!verifyWebhookSignatureModule(req)) {
      bump('webhookDenied');
      res.sendStatus(403);
      return;
    }
    const body = req.body;

    if (body.object === 'whatsapp_business_account') {
      const entry = body.entry?.[0];
      const changes = entry?.changes?.[0];
      const value = changes?.value;
      const tenantId = config.ENABLE_TENANT_SCOPING
        ? String(value?.metadata?.phone_number_id || config.PHONE_NUMBER_ID || 'default')
        : null;
      
      if (value?.messages?.[0]) {
        const message = value.messages[0];
        const ok = await shouldProcessInboundMessageModule(message.id, tenantId);
        if (!ok) {
          res.sendStatus(200);
          return;
        }
        const from = message.from;
        let messageBody = (message.text?.body || '').trim();
        if (message.type === 'interactive') {
          const bid = message.interactive?.button_reply?.id || message.interactive?.list_reply?.id || '';
          if (bid) messageBody = bid.toLowerCase();
        } else if (message.type === 'audio') {
          const mediaId = message.audio?.id;
          const audio = mediaId ? await downloadMediaBuffer(mediaId) : { buffer: Buffer.alloc(0), mimeType: undefined };
          const transcript = await transcribeAudio(audio.buffer, audio.mimeType);
          const note = (transcript || '').trim();
          if (note) messageBody = `voice_note:${note}`;
          else messageBody = `voice_note_ref:${String(mediaId || '').trim()}`;
        } else {
          messageBody = messageBody.toLowerCase();
        }
        
        console.log(`Inbound message type=${message.type} from=${maskPhone(from)}`);
        
        // Process the message
        await handleMessageModule(from, messageBody, tenantId);
      } else {
        const hasStatuses = Array.isArray(value?.statuses) && value.statuses.length > 0;
        console.log('Webhook event received but no messages array; statuses:', hasStatuses ? JSON.stringify(value.statuses) : 'none');
      }
    }

    bump('webhookOk');
    res.sendStatus(200);
  } catch (error) {
    bump('webhookErrors');
    console.error('Error processing webhook:', error);
    res.sendStatus(500);
  }
});

app.post('/webhook/razorpay', razorpayLimiter, async (req, res) => {
  let claimActive = false;
  let claimEventKey = '';
  let claimTenantId = null;
  const releaseClaim = async () => {
    if (!claimActive || !claimEventKey) return;
    await releasePaymentEvent(claimEventKey, claimTenantId);
    claimActive = false;
    claimEventKey = '';
    claimTenantId = null;
  };

  try {
    const secret = config.RAZORPAY_WEBHOOK_SECRET;
    if (!secret) {
      res.status(500).json({ ok: false, error: 'RAZORPAY_WEBHOOK_SECRET missing' });
      return;
    }
    const signature = String(req.get('x-razorpay-signature') || '');
    if (!signature) {
      bump('razorpayDenied');
      res.sendStatus(401);
      return;
    }
    const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    if (!safeEqual(signature, expected)) {
      bump('razorpayDenied');
      res.sendStatus(401);
      return;
    }

    const event = String(req.body?.event || '');
    const supported = new Set(['payment_link.paid', 'payment.captured', 'order.paid']);
    if (!supported.has(event)) {
      res.status(200).json({ ok: true, ignored: event || 'unknown_event' });
      return;
    }

    const paymentEntity = req.body?.payload?.payment?.entity || {};
    const paymentLinkEntity = req.body?.payload?.payment_link?.entity || {};
    const invoiceEntity = req.body?.payload?.invoice?.entity || {};
    const notes = paymentEntity?.notes || paymentLinkEntity?.notes || invoiceEntity?.notes || {};

    let tenantId = resolveTenantId(req, { allowDefault: false });
    if (config.ENABLE_TENANT_SCOPING && !tenantId) {
      tenantId = String(notes?.tenant_id || notes?.tenant || '').trim();
    }
    if (config.ENABLE_TENANT_SCOPING && !tenantId) {
      res.status(400).json({ ok: false, error: 'Missing tenant_id for scoped mode' });
      return;
    }

    const paymentId =
      paymentEntity?.id ||
      paymentLinkEntity?.id ||
      invoiceEntity?.id ||
      notes?.payment_id ||
      '';
    const amountPaise =
      parseInt(String(paymentEntity?.amount ?? paymentLinkEntity?.amount ?? invoiceEntity?.amount ?? notes?.amount_paise ?? ''), 10) || 0;
    const currency = String(paymentEntity?.currency || paymentLinkEntity?.currency || invoiceEntity?.currency || notes?.currency || 'INR').toUpperCase();
    const planCode = inferPlanCode(notes, amountPaise);
    const bodyHash = crypto.createHash('sha256').update(rawBody).digest('hex');
    const eventKeyBase = paymentId ? `payment:${paymentId}` : `${event}:${bodyHash}`;
    const eventKey = (config.ENABLE_TENANT_SCOPING && tenantId) ? `${tenantId}:${eventKeyBase}` : eventKeyBase;

    const existingByEvent = await findPaymentLogByEventKey(eventKey, tenantId);
    if (existingByEvent) {
      res.status(200).json({ ok: true, ignored: 'duplicate_event' });
      return;
    }
    if (paymentId) {
      const existingByPayment = await findPaymentLogByPaymentId(paymentId, tenantId);
      if (existingByPayment) {
        res.status(200).json({ ok: true, ignored: 'duplicate_payment' });
        return;
      }
    }

    let eventClaim = await claimPaymentEvent(eventKey, tenantId);
    if (!eventClaim.ok && eventClaim.reason === 'duplicate') {
      const existingAfterDuplicate = await findPaymentLogByEventKey(eventKey, tenantId);
      if (existingAfterDuplicate) {
        res.status(200).json({ ok: true, ignored: 'duplicate_event' });
        return;
      }
      await releasePaymentEvent(eventKey, tenantId);
      eventClaim = await claimPaymentEvent(eventKey, tenantId);
    }
    if (!eventClaim.ok) {
      if (eventClaim.reason === 'duplicate') {
        res.status(200).json({ ok: true, ignored: 'duplicate_event' });
        return;
      }
      if (eventClaim.reason === 'schema_missing') {
        res.status(409).json({ ok: false, error: 'Run database_hardening.sql to add payment event table' });
        return;
      }
      const detail = eventClaim.error?.message || eventClaim.reason;
      console.error('payment event claim failed:', detail);
      res.status(500).json({ ok: false, error: 'db' });
      return;
    }
    claimActive = true;
    claimEventKey = eventKey;
    claimTenantId = tenantId;

    const rawPhone =
      paymentEntity?.contact ||
      paymentLinkEntity?.customer?.contact ||
      paymentLinkEntity?.customer?.phone ||
      invoiceEntity?.customer_details?.phone ||
      notes?.phone ||
      notes?.mobile ||
      notes?.user_phone ||
      '';
    const userPhone = await resolveExistingUserPhone(rawPhone, tenantId);
    if (!userPhone) {
      await releaseClaim();
      res.status(200).json({ ok: true, ignored: 'user_not_found' });
      return;
    }

    const defaultPlanDays = Number.isInteger(config.PRO_PLAN_DAYS) ? Math.max(1, config.PRO_PLAN_DAYS) : 30;
    const amountBasedDays = amountPaise === 19900 ? 30 : amountPaise === 49900 ? 30 : defaultPlanDays;
    const planDays = parsePositiveInt(notes?.plan_days || notes?.days, amountBasedDays);
    const { data: currentUser, error: currentErr } = await supabase
      .from('users')
      .select('pro_expires_at')
      .match(userMatch(tenantId, userPhone))
      .single();
    if (currentErr) {
      if (/pro_expires_at|is_pro/i.test(currentErr.message || '')) {
        await releaseClaim();
        res.status(409).json({ ok: false, error: 'Run database_hardening.sql to add pro columns' });
        return;
      }
      console.error('users select before pro update failed:', currentErr.message);
    }

    const nowMs = Date.now();
    const currentExpiry = Date.parse(currentUser?.pro_expires_at || '');
    const startMs = Number.isFinite(currentExpiry) && currentExpiry > nowMs ? currentExpiry : nowMs;
    const nextExpiry = new Date(startMs + (planDays * 24 * 60 * 60 * 1000)).toISOString();

    const { error: upErr } = await supabase
      .from('users')
      .update({ is_pro: true, pro_expires_at: nextExpiry })
      .match(userMatch(tenantId, userPhone));
    if (upErr) {
      if (/pro_expires_at|is_pro/i.test(upErr.message || '')) {
        await releaseClaim();
        res.status(409).json({ ok: false, error: 'Run database_hardening.sql to add pro columns' });
        return;
      }
      console.error('users pro update failed:', upErr.message);
      await releaseClaim();
      res.status(500).json({ ok: false, error: 'db' });
      return;
    }

    const paymentLogRow = withTenant(tenantId, {
      payment_id: paymentId || null,
      event_key: eventKey,
      event_name: event,
      user_phone: userPhone,
      plan_code: planCode,
      plan_days: planDays,
      amount_paise: amountPaise || null,
      currency,
      status: 'paid',
      paid_at: new Date().toISOString(),
      notes
    });
    const { error: payLogErr } = await supabase.from('subscription_payments').insert(paymentLogRow);
    if (payLogErr && String(payLogErr.code) === '23505') {
      claimActive = false;
      claimEventKey = '';
      claimTenantId = null;
      res.status(200).json({ ok: true, ignored: 'duplicate_event' });
      return;
    }
    if (payLogErr && /subscription_payments/i.test(payLogErr.message || '')) {
      await releaseClaim();
      res.status(409).json({ ok: false, error: 'Run database_hardening.sql to add subscription_payments table' });
      return;
    }
    if (payLogErr) {
      console.error('subscription_payments insert failed:', payLogErr.message);
      await releaseClaim();
      res.status(500).json({ ok: false, error: 'db' });
      return;
    }

    claimActive = false;
    claimEventKey = '';
    claimTenantId = null;

    const expiryDate = nextExpiry.slice(0, 10);
    await sendWhatsAppMessage(userPhone, `Pro activated (${planCode}). Valid until ${expiryDate}.`);
    bump('razorpayOk');
    res.status(200).json({
      ok: true,
      user_phone: userPhone,
      expires_at: nextExpiry,
      plan_code: planCode,
      plan_days: planDays,
      amount_paise: amountPaise || null
    });
  } catch (e) {
    await releaseClaim();
    bump('razorpayErrors');
    console.error('razorpay webhook error:', e.message);
    res.status(500).json({ ok: false });
  }
});

// Health endpoints
app.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'therapy-tracker-bot',
    version: packageJson.version,
    started_at: SERVER_STARTED_AT
  });
});

app.get('/health/live', (_req, res) => {
  res.json({
    ok: true,
    live: true,
    started_at: SERVER_STARTED_AT
  });
});

app.get('/health/ready', async (req, res) => {
  try {
    const checks = { env: true, db: false };
    const envRequired = [
      'WHATSAPP_TOKEN',
      'PHONE_NUMBER_ID',
      'SUPABASE_URL',
      (config.SUPABASE_SERVICE_ROLE || config.SUPABASE_KEY) ? 'supabase_key_present' : ''
    ].filter(Boolean);
    checks.env = envRequired.every((k) => (k === 'supabase_key_present' ? true : Boolean(process.env[k])));
    const { error } = await supabase.from('users').select('id').limit(1);
    checks.db = !error;
    if (error) {
      return res.status(503).json({
        ok: false,
        ready: false,
        checks,
        error: error.message,
        request_id: req.requestId
      });
    }
    const ready = checks.env && checks.db;
    return res.status(ready ? 200 : 503).json({
      ok: ready,
      ready,
      checks,
      version: packageJson.version,
      started_at: SERVER_STARTED_AT,
      uptime_sec: Math.floor(process.uptime()),
      request_id: req.requestId,
      ops
    });
  } catch (e) {
    return res.status(503).json({
      ok: false,
      ready: false,
      error: e?.message || String(e),
      request_id: req.requestId
    });
  }
});

app.get('/privacy', (req, res) => {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Privacy Policy Â· Therapy Tracker Bot</title><style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.6;margin:40px;max-width:860px}h1{font-size:28px;margin-bottom:8px}h2{font-size:20px;margin-top:28px}code,pre{background:#f6f8fa;padding:2px 6px;border-radius:4px}</style></head><body><h1>Privacy Policy</h1><p>Therapy Tracker Bot helps users log therapy sessions and receive summaries via WhatsApp.</p><h2>Data We Process</h2><ul><li>WhatsApp phone number</li><li>Message content used for commands (e.g., attended, missed, summary, setup)</li><li>Session records: date, status, optional cancellation reason</li><li>Monthly configuration: paid sessions, cost, carry forward</li></ul><h2>Purpose</h2><p>We use the data to log sessions, generate summaries, and provide the service requested by the user.</p><h2>Storage & Retention</h2><p>Data is stored in Supabase in the region selected on project creation and retained until the user requests deletion or the account is deactivated.</p><h2>Sharing</h2><p>Data is not sold. It is shared only with our processors necessary to deliver the service (e.g., WhatsApp Cloud API by Meta and Supabase as our database provider).</p><h2>Security</h2><p>Access tokens and API keys are kept in server environment variables. Transport uses HTTPS.</p><h2>Your Rights</h2><p>Users can request access, correction, or deletion of their data by contacting us.</p><h2>Contact</h2><p>Email: privacy@therapy-tracker.example</p><h2>Updates</h2><p>We may update this policy. Changes will be posted on this page with the updated date.</p><p>Last updated: ${new Date().toISOString().slice(0,10)}</p></body></html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(200).send(html);
});

app.get('/health/db', async (req, res) => {
  try {
    const { error } = await supabase.from('users').select('id').limit(1);
    if (error) return res.status(500).json({ ok: false, error: error.message, request_id: req.requestId });
    res.json({ ok: true, request_id: req.requestId });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e), request_id: req.requestId });
  }
});

app.post('/internal/reminders', async (req, res) => {
  try {
    const token = req.headers['x-reminder-token'];
    if (!token || token !== config.REMINDER_TOKEN) return res.sendStatus(401);
    const { runOnce } = require('./reminder');
    await runOnce();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.use((err, req, res, _next) => {
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ ok: false, error: 'invalid_json', request_id: req.requestId });
  }
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ ok: false, error: 'payload_too_large', request_id: req.requestId });
  }
  console.error('Unhandled express error:', err?.message || err);
  return res.status(500).json({ ok: false, error: 'internal_error', request_id: req.requestId });
});

// Start server
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

function shutdown(signal) {
  console.log(`Received ${signal}. Starting graceful shutdown...`);
  server.close(() => {
    console.log('HTTP server closed.');
    process.exit(0);
  });
  setTimeout(() => {
    console.error('Force exit after shutdown timeout');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});
