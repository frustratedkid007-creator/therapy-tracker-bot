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

  if (!parentsByChild.size) {
    for (const u of users || []) {
      if (u.reminders_enabled === false) continue
      const tz = (u.timezone && String(u.timezone)) || DEFAULT_TZ
      const { today, hour, weekday } = nowPartsInTimeZone(tz)
      const reminderHour = Number.isInteger(u.reminder_time_hour) ? u.reminder_time_hour : DEFAULT_REMINDER_HOUR
      if (weekday.startsWith('Sat') || weekday.startsWith('Sun')) continue
      if (hour < reminderHour) continue
      if (u.last_reminder_sent && String(u.last_reminder_sent) === today) continue
      const exists = await hasLogTodayByChild(tenantId, null, u.phone, today)
      if (exists) continue
      try {
        await sendMessage(u.phone, `⏰ Reminder\nNo session logged today yet.\nReply: done / missed / holiday`)
        await supabase.from('users').update({ last_reminder_sent: today }).match(userMatch(tenantId, u.phone))
        console.log('Reminder sent to', u.phone)
      } catch (e) {
        console.error('Reminder send failed for', u.phone, e.response?.data || e.message)
      }
    }
    return
  }

  for (const [childId, phonesSet] of parentsByChild.entries()) {
    for (const phone of phonesSet) {
      const u = uMap.get(phone)
      if (!u || u.reminders_enabled === false) continue
      const tz = (u.timezone && String(u.timezone)) || DEFAULT_TZ
      const { today, hour, weekday } = nowPartsInTimeZone(tz)
      const reminderHour = Number.isInteger(u.reminder_time_hour) ? u.reminder_time_hour : DEFAULT_REMINDER_HOUR
      if (weekday.startsWith('Sat') || weekday.startsWith('Sun')) continue
      if (hour < reminderHour) continue
      if (u.last_reminder_sent && String(u.last_reminder_sent) === today) continue
      const exists = await hasLogTodayByChild(tenantId, childId, null, today)
      if (exists) continue
      try {
        await sendMessage(phone, `⏰ Reminder\nNo session logged today yet.\nReply: done / missed / holiday`)
        await supabase.from('users').update({ last_reminder_sent: today }).match(userMatch(tenantId, phone))
        console.log('Reminder sent to', phone)
      } catch (e) {
        console.error('Reminder send failed for', phone, e.response?.data || e.message)
      }
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
  module.exports = { runOnce }
}
