const crypto = require('crypto');
const { supabase } = require('./db');
const { config } = require('./config');

const processedMessageIds = new Map();
const duplicateWindowMs = 5 * 60 * 1000;

function scopedMessageId(messageId, tenantId) {
  if (!messageId) return '';
  if (!config.ENABLE_TENANT_SCOPING || !tenantId) return String(messageId);
  return `${tenantId}:${messageId}`;
}

function safeEqual(a, b) {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function verifyWebhookSignature(req) {
  if (config.SKIP_WEBHOOK_SIGNATURE === 'true') return true;
  if (!config.WHATSAPP_APP_SECRET) return false;
  const signature = req.get('x-hub-signature-256');
  if (!signature) return false;
  const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
  const expected = `sha256=${crypto.createHmac('sha256', config.WHATSAPP_APP_SECRET).update(rawBody).digest('hex')}`;
  return safeEqual(signature, expected);
}

function seenRecently(messageId) {
  if (!messageId) return false;
  const now = Date.now();
  for (const [id, ts] of processedMessageIds.entries()) {
    if (now - ts > duplicateWindowMs) processedMessageIds.delete(id);
  }
  if (processedMessageIds.has(messageId)) return true;
  processedMessageIds.set(messageId, now);
  return false;
}

async function shouldProcessInboundMessage(messageId, tenantId) {
  const scopedId = scopedMessageId(messageId, tenantId);
  if (!scopedId) return true;
  if (seenRecently(scopedId)) return false;
  try {
    const row = (config.ENABLE_TENANT_SCOPING && tenantId)
      ? { message_id: scopedId, tenant_id: tenantId }
      : { message_id: scopedId };
    const { error } = await supabase.from('processed_inbound_messages').insert(row);
    if (!error) return true;
    if (String(error.code) === '23505') return false;
    return true;
  } catch {
    return true;
  }
}

module.exports = {
  verifyWebhookSignature,
  shouldProcessInboundMessage
};
