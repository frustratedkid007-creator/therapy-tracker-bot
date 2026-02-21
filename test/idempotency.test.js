require('./test_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { supabase } = require('../src/db');
const { verifyWebhookSignature, shouldProcessInboundMessage } = require('../src/idempotency');

test('verifyWebhookSignature validates HMAC header', () => {
  const raw = Buffer.from(JSON.stringify({ hello: 'world' }));
  const expected = `sha256=${crypto.createHmac('sha256', process.env.WHATSAPP_APP_SECRET).update(raw).digest('hex')}`;
  const req = {
    rawBody: raw,
    body: { hello: 'world' },
    get: (name) => (name === 'x-hub-signature-256' ? expected : '')
  };
  assert.equal(verifyWebhookSignature(req), true);
});

test('verifyWebhookSignature rejects wrong signature', () => {
  const raw = Buffer.from(JSON.stringify({ hello: 'world' }));
  const req = {
    rawBody: raw,
    body: { hello: 'world' },
    get: (name) => (name === 'x-hub-signature-256' ? 'sha256=bad' : '')
  };
  assert.equal(verifyWebhookSignature(req), false);
});

test('shouldProcessInboundMessage is idempotent with tenant scope', async () => {
  const originalFrom = supabase.from;
  const inserted = new Set();
  supabase.from = (table) => {
    assert.equal(table, 'processed_inbound_messages');
    return {
      insert: async (row) => {
        const key = String(row.message_id || '');
        if (inserted.has(key)) return { error: { code: '23505', message: 'duplicate key' } };
        inserted.add(key);
        return { error: null };
      }
    };
  };
  try {
    const first = await shouldProcessInboundMessage('m-1', 'tenant-a');
    const second = await shouldProcessInboundMessage('m-1', 'tenant-a');
    const third = await shouldProcessInboundMessage('m-1', 'tenant-b');
    assert.equal(first, true);
    assert.equal(second, false);
    assert.equal(third, true);
  } finally {
    supabase.from = originalFrom;
  }
});
