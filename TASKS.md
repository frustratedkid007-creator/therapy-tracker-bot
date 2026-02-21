# Therapy Tracker Implementation Tasks

Updated: 2026-02-21

## Status Legend
- `[x]` Completed
- `[-]` In Progress
- `[ ]` Remaining

## High Priority
- `[x]` HP-01: Reset month flow reliability
  - Reset now clears month sessions, holidays, monthly config, and monthly feedback notes.
  - Added visible `Reset this month` menu action.
- `[x]` HP-02: Invite acceptance + role permissions
  - Owner invites create pending membership (`pending_parent` / `pending_therapist`).
  - Invitee must `accept_invite` or `reject_invite`.
  - Permissions enforced by role:
    - owner: full access
    - parent: track + setup/reset + billing/data
    - therapist: tracking/notes/view only
- `[x]` HP-03: Multi-date / range logging UX
  - Added commands: `attended_dates`, `attended_range`, `missed_dates`, `missed_range`.
  - Added validation + duplicate/conflict/future-date safe skips with summary response.
- `[x]` HP-04: Voice-note reliability pipeline
  - Added fallback event handling when transcription fails (`voice_note_ref:*`).
  - Added metadata migration: `database_voice_notes_hardening.sql` (`source`, `media_id`, `transcription_status`).
  - Bot now prompts for text fallback instead of dropping note silently.
- `[x]` HP-05: Billing trust loop improvements
  - Added `payment_status` and `reconcile_payment <payment_id>`.
  - Added automatic Pro renewal nudges in reminder run (once/day/user near expiry).
  - Added reconcile audit event (`payment_reconciled`).
- `[x]` HP-06: Cleanup duplicate legacy paths in `server.js`
  - Removed obsolete in-file bot logic; webhook now uses `src/handlers.js` only.
- `[x]` HP-07: Basic automated tests for money/data critical paths
  - Added Node test suite for bulk parser/permissions/month bounds.
  - Added webhook signature and inbound idempotency tests.

## Medium Priority
- `[x]` MP-01: Structured therapist note template (goal/activity/response/homework)
  - New command flow: `note_template` / `structured_note` / `therapist_note`.
  - 4-step guided capture (goal, activity, response, homework) saved into `feedback_notes`.
- `[x]` MP-02: Weekly parent digest with actionable insight
  - New command: `weekly_digest` (alias: `parent_digest`).
  - Includes adherence, top miss reason, mood trend, note count, and next-week action tip.
- `[x]` MP-03: Better PDF/report trend sections
  - Monthly report PDF now includes weekly trend buckets, missed reason breakdown, mood trend, and note/homework highlights.
- `[x]` MP-04: Missed-session reason analytics
  - New command: `missed_analytics` (alias: `missed_report`).
  - Normalized reason categories and high-risk weekday summary added.
- `[x]` MP-05: Reminder intelligence (risk-based nudges)
  - Reminder job now computes 14-day risk (low/medium/high) and sends tailored reminder text.
  - Added per-run dedupe guard to avoid duplicate reminders to same phone.
- `[x]` MP-06: Clinic admin commands
  - Owner-only commands: `clinic_admin`, `admin_members`, `admin_risk`.
  - Added aggregate child/member/session/risk visibility for clinic-level operation.

## Low Priority
- `[x]` LP-01: Web calendar/tap UI
  - `/mytracker` now includes tap calendar with per-day status cycle and save.
  - Added secure APIs: `POST /mytracker/save` and `POST /mytracker/reset-month`.
- `[x]` LP-02: Multilingual support
  - Added language commands: `language`, `lang:en`, `lang:hi`, `lang:te`.
  - Added localized responses for key LP flows (language, referral/coupon, streak).
- `[x]` LP-03: Branding/theme variants
  - Added themes: `sunrise`, `ocean`, `forest` in tracker UI.
  - Added commands: `theme`, `theme:sunrise`, `theme:ocean`, `theme:forest`.
- `[x]` LP-04: Referrals/coupons
  - Added commands: `my_referral`, `redeem <code>`, `apply_coupon <code>`.
  - Added migration file `database_low_priority.sql` for referral/coupon schema.
- `[x]` LP-05: Gamified streak journeys
  - Added `streak` / `journey` command with current/best/next milestone.
  - Added milestone badge nudges on attended logs.

## Next Execution Order
1. `[x]` Hardening + observability pass
2. `[x]` Production checklist + runbook
3. `[ ]` Closed beta feedback loop
