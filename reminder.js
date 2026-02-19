const axios = require('axios')
const cron = require('node-cron')
const { createClient } = require('@supabase/supabase-js')
require('dotenv').config()

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_KEY)
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID
const TZ = process.env.TIMEZONE || 'Asia/Kolkata'
const REMINDER_HOUR = parseInt(process.env.REMINDER_TIME_HOUR || '13', 10)

function nowParts() {
  const now = new Date()
  const dateStr = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
  const hourStr = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false }).format(now)
  return { today: dateStr, hour: parseInt(hourStr, 10) }
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

async function hasLogTodayByChild(childId, userPhone, today) {
  const byChild = childId ? { child_id: childId } : { user_phone: userPhone }
  const { data: s } = await supabase.from('sessions').select('id').eq('date', today).eq('status', 'attended').match(byChild).limit(1)
  if (Array.isArray(s) && s.length) return true
  const { data: c } = await supabase.from('sessions').select('id').eq('date', today).eq('status', 'cancelled').match(byChild).limit(1)
  if (Array.isArray(c) && c.length) return true
  const { data: h } = await supabase.from('holidays').select('id').eq('date', today).match(byChild).limit(1)
  if (Array.isArray(h) && h.length) return true
  return false
}

async function runOnce() {
  const { today, hour } = nowParts()
  if (hour < REMINDER_HOUR) return
  // Skip weekends: 0=Sunday, 6=Saturday (Kolkata)
  const wd = new Date().toLocaleString('en-US', { timeZone: TZ, weekday: 'short' })
  if (wd.startsWith('Sat') || wd.startsWith('Sun')) return

  // Build parent map
  const { data: members } = await supabase.from('child_members').select('child_id, member_phone, role')
  const parentsByChild = new Map()
  for (const m of members || []) {
    const role = (m.role || 'member').toLowerCase()
    if (role === 'therapist') continue
    if (!parentsByChild.has(m.child_id)) parentsByChild.set(m.child_id, new Set())
    parentsByChild.get(m.child_id).add(m.member_phone)
  }

  // Pull user settings into a map
  const { data: users, error } = await supabase.from('users').select('*')
  if (error) throw new Error(error.message)
  const uMap = new Map((users || []).map(u => [u.phone, u]))

  // If no children configured, fall back to per-user check
  if (!parentsByChild.size) {
    for (const u of users || []) {
      if (u.reminders_enabled === false) continue
      if (u.last_reminder_sent && String(u.last_reminder_sent) === today) continue
      const exists = await hasLogTodayByChild(null, u.phone, today)
      if (exists) continue
      try {
        await sendMessage(u.phone, `⏰ Reminder\nNo session logged today yet.\nReply: done / missed / holiday`)
        await supabase.from('users').update({ last_reminder_sent: today }).eq('phone', u.phone)
        console.log('Reminder sent to', u.phone)
      } catch (e) {
        console.error('Reminder send failed for', u.phone, e.response?.data || e.message)
      }
    }
    return
  }

  // Iterate per child and notify only parents
  for (const [childId, phonesSet] of parentsByChild.entries()) {
    const exists = await hasLogTodayByChild(childId, null, today)
    if (exists) continue
    for (const phone of phonesSet) {
      const u = uMap.get(phone)
      if (!u || u.reminders_enabled === false) continue
      if (u.last_reminder_sent && String(u.last_reminder_sent) === today) continue
      try {
        await sendMessage(phone, `⏰ Reminder\nNo session logged today yet.\nReply: done / missed / holiday`)
        await supabase.from('users').update({ last_reminder_sent: today }).eq('phone', phone)
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
    const expr = process.env.REMINDER_CRON || '0 0 13 * * 1-5' // 13:00 Mon–Fri
    cron.schedule(expr, () => {
      runOnce().catch(e => console.error('reminder run error', e.message))
    }, { timezone: TZ })
    console.log(`Reminder scheduler started: ${expr} tz=${TZ}`)
  }
} else {
  module.exports = { runOnce }
}
