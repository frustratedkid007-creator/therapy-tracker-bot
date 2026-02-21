const axios = require('axios')
const cron = require('node-cron')
const { config } = require('./src/config')
const { supabase } = require('./src/db')

const WHATSAPP_TOKEN = config.WHATSAPP_TOKEN
const PHONE_NUMBER_ID = config.PHONE_NUMBER_ID
const DEFAULT_TZ = config.DEFAULT_TIMEZONE
const DEFAULT_REMINDER_HOUR = config.DEFAULT_REMINDER_HOUR
const TENANT_ID = config.ENABLE_TENANT_SCOPING ? (process.env.TENANT_ID || config.PHONE_NUMBER_ID || 'default') : null

function nowPartsInTimeZone(timeZone) {
  const tz = timeZone || DEFAULT_TZ
  const now = new Date()
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
  const hour = parseInt(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false }).format(now), 10)
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(now)
  return { today, hour, weekday, timeZone: tz }
}

function withTenant(tenantId, data) {
  if (!config.ENABLE_TENANT_SCOPING || !tenantId) return data
  return { tenant_id: tenantId, ...data }
}

function userMatch(tenantId, phone) {
  return withTenant(tenantId, { phone })
}

async function sendMessage(to, text) {
  await axios.post(`https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`, {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body: text }
  }, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' }
  })
}

function isProActive(user) {
  if (!user || user.is_pro !== true) return false
  if (!user.pro_expires_at) return true
  const t = Date.parse(user.pro_expires_at)
  return Number.isFinite(t) && t > Date.now()
}

function daysUntilExpiry(user) {
  if (!user?.pro_expires_at) return null
  const t = Date.parse(user.pro_expires_at)
  if (!Number.isFinite(t)) return null
  return Math.max(0, Math.ceil((t - Date.now()) / (24 * 60 * 60 * 1000)))
}

function deriveRiskLevel(attended, missed) {
  const total = Math.max(0, attended + missed)
  if (missed >= 3) return 'high'
  if (total >= 4 && (attended / total) < 0.6) return 'high'
  if (missed >= 1) return 'medium'
  return 'low'
}

function dateMinusDaysIso(dateIso, days) {
  const d = new Date(`${String(dateIso).slice(0, 10)}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - Math.max(0, days))
  return d.toISOString().slice(0, 10)
}

async function loadRecentRiskCounts(tenantId, childId, userPhone, today) {
  const start = dateMinusDaysIso(today, 13)
  const match = childId ? { child_id: childId } : { user_phone: userPhone }
  const scoped = withTenant(tenantId, match)
  try {
    const { data, error } = await supabase
      .from('sessions')
      .select('status,date')
      .match(scoped)
      .gte('date', start)
      .lte('date', today)
    if (error) return { attended: 0, missed: 0, level: 'low' }
    const rows = Array.isArray(data) ? data : []
    const attended = rows.filter(r => r.status === 'attended').length
    const missed = rows.filter(r => r.status === 'cancelled').length
    return { attended, missed, level: deriveRiskLevel(attended, missed) }
  } catch (_) {
    return { attended: 0, missed: 0, level: 'low' }
  }
}

function buildRiskReminderText(risk) {
  const base = `\u23F0 Reminder\nNo session logged today yet.\nReply: done / missed / holiday`
  if (!risk || risk.level === 'low') return base
  if (risk.level === 'medium') {
    return (
      `${base}\n\n` +
      `\u26A0\uFE0F Risk watch: ${risk.missed} missed in last 14 days.\n` +
      `Try locking tomorrow's slot now.`
    )
  }
  return (
    `${base}\n\n` +
    `\uD83D\uDEA8 High risk: ${risk.missed} missed and ${risk.attended} attended in last 14 days.\n` +
    `Please confirm next 2 sessions with backup timing.`
  )
}

async function wasRenewalNudgeSentToday(tenantId, phone, today) {
  try {
    const { data, error } = await supabase
      .from('consent_events')
      .select('created_at,event_type')
      .match(withTenant(tenantId, { user_phone: phone }))
      .eq('event_type', 'renewal_nudge_sent')
      .order('created_at', { ascending: false })
      .limit(1)
    if (error) return false
    const row = Array.isArray(data) && data.length ? data[0] : null
    if (!row?.created_at) return false
    return String(row.created_at).slice(0, 10) === today
  } catch (_) {
    return false
  }
}

async function logRenewalNudge(tenantId, phone, daysLeft, expiresAt) {
  try {
    const row = withTenant(tenantId, {
      user_phone: phone,
      event_type: 'renewal_nudge_sent',
      details: { days_left: daysLeft, expires_at: expiresAt || null },
      created_at: new Date().toISOString()
    })
    await supabase.from('consent_events').insert(row)
  } catch (_) {
  }
}

function buildRenewLinksMessage() {
  const link199 = config.RAZORPAY_PAYMENT_LINK_199 || config.RAZORPAY_PAYMENT_LINK
  const link499 = config.RAZORPAY_PAYMENT_LINK_499
  if (link199 && link499) {
    return (
      `\uD83D\uDD01 Pro renewal reminder\n` +
      `Your Pro expires soon.\n` +
      `INR 199: ${link199}\n` +
      `INR 499: ${link499}`
    )
  }
  if (link499 || link199) {
    return (
      `\uD83D\uDD01 Pro renewal reminder\n` +
      `Your Pro expires soon.\n` +
      `${link499 || link199}`
    )
  }
  return ''
}

async function maybeSendRenewalNudge(tenantId, user, today) {
  if (!isProActive(user)) return
  const daysLeft = daysUntilExpiry(user)
  if (daysLeft === null || daysLeft > 7) return
  const already = await wasRenewalNudgeSentToday(tenantId, user.phone, today)
  if (already) return
  const msg = buildRenewLinksMessage()
  if (!msg) return
  try {
    await sendMessage(user.phone, msg)
    await logRenewalNudge(tenantId, user.phone, daysLeft, user.pro_expires_at || null)
    console.log('Renewal nudge sent to', user.phone, 'days_left=', daysLeft)
  } catch (e) {
    console.error('Renewal nudge failed for', user.phone, e.response?.data || e.message)
  }
}

async function hasLogTodayByChild(tenantId, childId, userPhone, today) {
  const byChild = childId ? { child_id: childId } : { user_phone: userPhone }
  const scoped = withTenant(tenantId, byChild)
  const { data: s } = await supabase.from('sessions').select('id').eq('date', today).eq('status', 'attended').match(scoped).limit(1)
  if (Array.isArray(s) && s.length) return true
  const { data: c } = await supabase.from('sessions').select('id').eq('date', today).eq('status', 'cancelled').match(scoped).limit(1)
  if (Array.isArray(c) && c.length) return true
  const { data: h } = await supabase.from('holidays').select('id').eq('date', today).match(scoped).limit(1)
  if (Array.isArray(h) && h.length) return true
  return false
}

async function sendLogReminderIfNeeded({ tenantId, user, phone, childId, sentPhones }) {
  if (!user || user.reminders_enabled === false) return
  if (sentPhones.has(phone)) return
  const tz = (user.timezone && String(user.timezone)) || DEFAULT_TZ
  const { today, hour, weekday } = nowPartsInTimeZone(tz)
  await maybeSendRenewalNudge(tenantId, user, today)
  const reminderHour = Number.isInteger(user.reminder_time_hour) ? user.reminder_time_hour : DEFAULT_REMINDER_HOUR
  if (weekday.startsWith('Sat') || weekday.startsWith('Sun')) return
  if (hour < reminderHour) return
  if (user.last_reminder_sent && String(user.last_reminder_sent) === today) return
  const exists = await hasLogTodayByChild(tenantId, childId, childId ? null : phone, today)
  if (exists) return

  const risk = await loadRecentRiskCounts(tenantId, childId, childId ? null : phone, today)
  const text = buildRiskReminderText(risk)
  try {
    await sendMessage(phone, text)
    await supabase.from('users').update({ last_reminder_sent: today }).match(userMatch(tenantId, phone))
    sentPhones.add(phone)
    console.log('Reminder sent to', phone, 'risk=', risk.level)
  } catch (e) {
    console.error('Reminder send failed for', phone, e.response?.data || e.message)
  }
}

async function runOnce() {
  const tenantId = TENANT_ID
  const { data: members } = await supabase.from('child_members').select('child_id, member_phone, role').match(withTenant(tenantId, {}))
  const parentsByChild = new Map()
  for (const m of members || []) {
    const role = (m.role || 'member').toLowerCase()
    if (role === 'therapist') continue
    if (!parentsByChild.has(m.child_id)) parentsByChild.set(m.child_id, new Set())
    parentsByChild.get(m.child_id).add(m.member_phone)
  }

  const { data: users, error } = await supabase.from('users').select('*').match(withTenant(tenantId, {}))
  if (error) throw new Error(error.message)
  const uMap = new Map((users || []).map(u => [u.phone, u]))
  const sentPhones = new Set()

  if (!parentsByChild.size) {
    for (const u of users || []) {
      await sendLogReminderIfNeeded({
        tenantId,
        user: u,
        phone: u.phone,
        childId: null,
        sentPhones
      })
    }
    return
  }

  for (const [childId, phonesSet] of parentsByChild.entries()) {
    for (const phone of phonesSet) {
      await sendLogReminderIfNeeded({
        tenantId,
        user: uMap.get(phone),
        phone,
        childId,
        sentPhones
      })
    }
  }
}

if (require.main === module) {
  if (process.env.RUN_ONCE === '1') {
    runOnce().catch(e => { console.error(e); process.exit(1) })
  } else {
    const expr = process.env.REMINDER_CRON || '0 0 * * *'
    cron.schedule(expr, () => {
      runOnce().catch(e => console.error('reminder run error', e.message))
    }, { timezone: 'Etc/UTC' })
    console.log(`Reminder scheduler started: ${expr}`)
  }
} else {
  module.exports = {
    runOnce,
    __test: {
      deriveRiskLevel,
      buildRiskReminderText
    }
  }
}
