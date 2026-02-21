# Production + Beta Runbook

Updated: 2026-02-21

## 1) Required migrations (in this order)
1. `database.sql` (only for fresh setup)
2. `database_hardening.sql`
3. `database_voice_notes_hardening.sql`
4. `database_low_priority.sql`
5. `database_rls_hardening.sql` (recommended for production lock-down)

## 2) Required production env vars
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE` (or `SUPABASE_KEY`, service role recommended)
- `WHATSAPP_TOKEN`
- `PHONE_NUMBER_ID`
- `VERIFY_TOKEN`
- `WHATSAPP_APP_SECRET`
- `TRACKER_SHARE_SECRET`
- `INTERNAL_REPORT_TOKEN`
- `REMINDER_TOKEN`
- `RAZORPAY_WEBHOOK_SECRET` (if payment webhook enabled)

## 3) New hardening env vars (optional but recommended)
- `REQUEST_LOGGING=true`
- `MAX_JSON_BODY_KB=256`
- `WEBHOOK_RATE_LIMIT_PER_MIN=120`
- `RAZORPAY_RATE_LIMIT_PER_MIN=60`
- `TRACKER_WRITE_RATE_LIMIT_PER_MIN=90`

## 4) Health checks
- Liveness: `GET /health/live`
- Readiness: `GET /health/ready`
- DB ping: `GET /health/db`

Expected readiness response:
- `ready=true`
- `checks.env=true`
- `checks.db=true`

## 5) Security posture checks
- Ensure `ALLOW_INSECURE_TRACKER=false` in production.
- Use signed tracker links only (`/internal/tracker-link` generated URLs).
- Keep `SKIP_WEBHOOK_SIGNATURE` unset or `false`.
- Rotate tokens/secrets quarterly.

## 6) Closed beta test plan (10-20 families)

### A. Core flows
- New user setup (`setup`)
- Attended/missed logging (single + bulk + calendar web save)
- Voice note fallback path
- Weekly digest / report PDF
- Reset month from WhatsApp and from web tracker

### B. Member/role flows
- Invite parent/therapist
- Accept/reject invite
- Verify permissions by role

### C. Payment flows
- `go_pro_199` and `go_pro_499` links
- Razorpay webhook idempotency (`duplicate_event` ignored)
- `payment_status` and `reconcile_payment <id>`

### D. Low-priority feature checks
- `language`, `lang:en|hi|te`
- `theme`, `theme:sunrise|ocean|forest`
- `my_referral`, `redeem <code>`, `apply_coupon <code>`
- `streak`
- `/mytracker` tap calendar save/reset

## 7) Go-live gates (pass/fail)
- [ ] All migrations applied without errors
- [ ] `/health/ready` stable for 24h
- [ ] Webhook signature validation enabled
- [ ] Reminder job executes successfully at least 3 runs
- [ ] Payment webhook tested with at least 2 successful events
- [ ] Data export/delete tested end-to-end
- [ ] 0 critical errors in logs during 7-day beta

## 8) Rollback plan
- Disable webhook by changing Meta callback URL temporarily.
- Set Render service to previous working deploy.
- Restore DB backup snapshot if data corruption occurs.
- Keep incident log with request ID (`x-request-id`) for failed requests.
