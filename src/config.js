require('dotenv').config();

function validateEnv() {
  const enableTenantScoping = String(process.env.ENABLE_TENANT_SCOPING || '').toLowerCase() === 'true';
  const allowInsecureTracker = String(process.env.ALLOW_INSECURE_TRACKER || '').toLowerCase() === 'true';
  const required = ['SUPABASE_URL', 'WHATSAPP_TOKEN', 'PHONE_NUMBER_ID'];
  const hasAnonSupabaseKey = Boolean(process.env.SUPABASE_KEY && process.env.SUPABASE_KEY.trim() !== '');
  const hasServiceRoleKey = Boolean(process.env.SUPABASE_SERVICE_ROLE && process.env.SUPABASE_SERVICE_ROLE.trim() !== '');
  if (process.env.NODE_ENV === 'production' && process.env.SKIP_WEBHOOK_SIGNATURE !== 'true') required.push('WHATSAPP_APP_SECRET');
  if (process.env.NODE_ENV === 'production') {
    if (!hasServiceRoleKey) required.push('SUPABASE_SERVICE_ROLE');
    if (!allowInsecureTracker) required.push('TRACKER_SHARE_SECRET');
    required.push('INTERNAL_REPORT_TOKEN');
    required.push('REMINDER_TOKEN');
  }
  if (!enableTenantScoping && process.env.TENANT_ID) {
    console.warn('TENANT_ID is set but ENABLE_TENANT_SCOPING is false. TENANT_ID will be ignored.');
  }
  const missing = required.filter((k) => !process.env[k] || process.env[k].trim() === '');
  if (!hasAnonSupabaseKey && !hasServiceRoleKey) {
    missing.push('SUPABASE_KEY or SUPABASE_SERVICE_ROLE');
  }
  if (missing.length) {
    console.error(`Missing environment variables: ${missing.join(', ')}`);
    process.exit(1);
  }
  const url = process.env.SUPABASE_URL;
  if (!/^https?:\/\//i.test(url)) {
    console.error('Invalid SUPABASE_URL. It must start with http:// or https://');
    process.exit(1);
  }
}

validateEnv();

const config = {
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_KEY: process.env.SUPABASE_KEY,
  SUPABASE_SERVICE_ROLE: process.env.SUPABASE_SERVICE_ROLE,
  ENABLE_TENANT_SCOPING: String(process.env.ENABLE_TENANT_SCOPING || '').toLowerCase() === 'true',
  WHATSAPP_TOKEN: process.env.WHATSAPP_TOKEN,
  PHONE_NUMBER_ID: process.env.PHONE_NUMBER_ID,
  VERIFY_TOKEN: process.env.VERIFY_TOKEN || 'therapy_tracker_2025',
  WHATSAPP_APP_SECRET: process.env.WHATSAPP_APP_SECRET,
  DEFAULT_TIMEZONE: process.env.DEFAULT_TIMEZONE || 'Asia/Kolkata',
  DEFAULT_REMINDER_HOUR: parseInt(process.env.REMINDER_TIME_HOUR || '13', 10),
  SKIP_WEBHOOK_SIGNATURE: process.env.SKIP_WEBHOOK_SIGNATURE,
  REMINDER_TOKEN: process.env.REMINDER_TOKEN,
  RAZORPAY_PAYMENT_LINK: process.env.RAZORPAY_PAYMENT_LINK,
  RAZORPAY_PAYMENT_LINK_199: process.env.RAZORPAY_PAYMENT_LINK_199,
  RAZORPAY_PAYMENT_LINK_499: process.env.RAZORPAY_PAYMENT_LINK_499,
  INTERNAL_REPORT_TOKEN: process.env.INTERNAL_REPORT_TOKEN,
  TRACKER_SHARE_SECRET: process.env.TRACKER_SHARE_SECRET,
  TRACKER_LINK_TTL_SEC: parseInt(process.env.TRACKER_LINK_TTL_SEC || '900', 10),
  ALLOW_INSECURE_TRACKER: String(process.env.ALLOW_INSECURE_TRACKER || '').toLowerCase() === 'true',
  RAZORPAY_WEBHOOK_SECRET: process.env.RAZORPAY_WEBHOOK_SECRET,
  PRO_PLAN_DAYS: parseInt(process.env.PRO_PLAN_DAYS || '30', 10),
  GROQ_API_KEY: process.env.GROQ_API_KEY,
  USE_SARVAM: String(process.env.USE_SARVAM || '').toLowerCase() === 'true',
  SARVAM_API_KEY: process.env.SARVAM_API_KEY,
  MAX_JSON_BODY_KB: parseInt(process.env.MAX_JSON_BODY_KB || '256', 10),
  REQUEST_LOGGING: String(process.env.REQUEST_LOGGING || '').toLowerCase() !== 'false',
  WEBHOOK_RATE_LIMIT_PER_MIN: parseInt(process.env.WEBHOOK_RATE_LIMIT_PER_MIN || '120', 10),
  RAZORPAY_RATE_LIMIT_PER_MIN: parseInt(process.env.RAZORPAY_RATE_LIMIT_PER_MIN || '60', 10),
  TRACKER_WRITE_RATE_LIMIT_PER_MIN: parseInt(process.env.TRACKER_WRITE_RATE_LIMIT_PER_MIN || '90', 10)
};

module.exports = { config };
