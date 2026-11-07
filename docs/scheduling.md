# Scheduling and availability

## Safe development defaults

The first API startup seeds one MongoDB `schedulingstates` document (`_id: "shop"`). Subsequent starts **preserve** saved settings. Defaults are editable placeholders, not confirmed business information:

| Setting | Default |
| --- | --- |
| Timezone | America/Chicago |
| Hours | Monday–Friday, 08:00–17:00; Saturday/Sunday closed |
| Daily break | 12:00–13:00 |
| Simultaneous capacity | 1 |
| Daily automatic confirmations | At most 3 |
| Minimum customer notice | 24 elapsed hours |
| Booking horizon | Through shop-local today + 14 calendar days, inclusive |
| Start grid | 30 minutes, aligned to local midnight |
| Buffer | 15 minutes after each appointment |
| Pending hold | 24 elapsed hours from reservation |
| Automatic booking | **Disabled** |
| Hours/capacity verified | **Both false** |

Cabin filter, engine filter, and wiper booking estimates are 30 minutes; tire rotation and oil change are 60; engine diagnostics is 90. Brake, AC/heating, and Other / Not Sure have editable 120-minute placeholders and **always require mechanic approval**. These estimates reserve time, not guaranteed repair completion times. The existing shared service catalog remains the source of accepted names and provisional service flags.

Both the service duration **and buffer** must fit inside one work interval and avoid lunch, closures, and blocked periods. For example, an hour-long visit at 11:00 is unavailable because its buffer would cross into lunch. No US holiday assumptions are invented: Edward must enter `closedDates` or blocked periods.

## Atomic protection on standalone MongoDB

`SchedulingState` stores settings, non-PII reservations, and daily automatic-admission counters together. Every capacity-affecting reservation, approval, block, and settings edit uses a MongoDB compare-and-swap on the singleton's unique `_id` and incrementing `revision`. A losing writer reloads and recalculates; after bounded retries it fails with 503 rather than bypassing protection. This is database-backed across API processes, not an in-memory mutex or non-atomic check/insert. No replica set, transaction support, or local MongoDB reconfiguration is required. Critical writes use majority acknowledgement and journaling (majority is one node on standalone MongoDB).

The intervals are end-exclusive: `[startAt, endAt + buffer)`. A sweep-line calculation enforces simultaneous capacity over the complete interval, including staggered start times and differing durations. Reservations and existing appointment records are conservatively combined by appointment ID without double counting. Settings edits and booking admissions share the same atomic revision, preventing booking-versus-block races. `settingsRevision` changes only when configuration changes, so an editor need not retry merely because a booking happened.

### Two-document failure policy

Standalone MongoDB cannot atomically update the coordination document and the separate legacy `Appointment` document together. The write ordering deliberately fails conservatively:

1. A booking commits a provisional reservation **before** saving its pending appointment. Interrupted/ambiguous saves may leave an orphan hold until expiry. Never release such a hold merely because the response failed: the insert may still commit.
2. Approval commits a **non-expiring confirmed reservation before** changing the appointment status and queuing the decision email. If the second write fails, the slot remains occupied even after the original pending hold expires. Edward can retry approval or decline the still-pending record; no successful confirmation is reported before its record is persisted.
3. Decline persists the terminal declined appointment first, then cleans its reservation. Reads also recognize declined records if cleanup is interrupted. A concurrent confirmation cannot resurrect a declined record because the status update is conditional on pending/missing legacy status.
4. Daily automatic-admission counters are conservative historical admissions: manual approvals do not consume them, but interrupted automatic approvals can consume a place. They are not refunded by cleanup. This can reduce automation, never exceed the daily limit.

Backup/restore **both collections together**. Direct appointment/ledger edits bypass the application contract; use the API. There is no automatic destructive rollback, record deletion, rescheduling, or cancellation of already-confirmed appointments. The singleton is suitable for this small single-shop workflow; much larger/multi-location throughput would require partitioning and careful migration. MongoDB's document-size limit fails writes rather than permitting an unreserved booking.

## Pending holds, expiry, and legacy records

- Pending requests occupy their full estimated duration plus buffer until reviewed, declined, or their hold expires. The default hold is 24 hours and can be configured from 1–168 hours.
- Expiration is checked on reads/admissions; it does not depend on a timer or TTL cleanup running on time. Expired ledger holds are pruned on subsequent mutations. **Appointment records stay pending and are never deleted or silently confirmed.**
- Confirming an expired request requires acquiring capacity again; a conflict returns HTTP 409 and leaves the request pending. Approval may occur inside the original 24-hour notice window or beyond a subsequently shortened horizon, but must still be future, obey the current calendar, and fit capacity.
- Confirmed appointments remain occupied until their interval/buffer ends; pending-hold expiry never releases a confirmed appointment.
- Existing records without scheduling metadata use the shared catalog's duration (including the old `Air Filter Change` alias) or the conservative unknown-service estimate, plus buffer. Old strings are preserved in storage and email; no migration rewrites them.
- Legacy pending age is `createdAt + pendingHoldHours`. A request lacking usable age metadata remains occupied until reviewed. Missing legacy status is treated as pending on reads/review without bulk rewriting records.
- New records snapshot UTC start/end, timezone, duration, buffer, hold expiry, and settings revision. Approvals preserve known duration/buffer bounds even if later defaults change. They revalidate against current working hours/closures. A changed timezone cannot reinterpret an expired request; Edward must decline it and obtain a new request instead.
- A valid legacy date with an unusable time conservatively blocks that whole date plus the maximum supported duration/buffer spillover. Clearly past records do not disable future dates. A completely unparseable active legacy date fails closed and needs data review. Do not guess its schedule or silently discard it.

## Timezones and daylight saving

Settings use an IANA timezone. Customers submit local `YYYY-MM-DD` / `HH:MM`; the server resolves them explicitly and stores UTC instants. Host/browser timezone is not used to decide availability. Calendar dates are strictly validated, including leap dates. Nonexistent spring-forward times and ambiguous fall-back times are rejected rather than guessed. Durations, notice, holds, and buffers measure elapsed time; weekdays, opening windows, and the horizon use the shop's local calendar. The tests cover Chicago, Berlin, and a half-hour clock-change timezone.

Existing known UTC snapshots remain authoritative. Timezone edits are rejected while future reservations are active. Holiday/blocked intervals may span dates. Blocked periods must use explicit ISO UTC timestamps ending in `Z`; their private reason is visible only to authenticated staff. New calendar/closure edits, blocks, and capacity reductions that invalidate occupied appointments are rejected rather than silently cancelling them.

## Hybrid automatic booking guard

Normal submissions **remain pending** under the seeded defaults. Automation requires all of:

- `automaticBookingEnabled: true`;
- `businessHoursVerified: true` and `capacityVerified: true`, after actual business confirmation;
- a non-provisional service whose scheduling rule permits automatic approval;
- a newly revalidated, atomically reserved slot and an available daily automatic-admission place.

Enabling the flag alone cannot confirm using placeholder hours/capacity. Editing saved hours/timezone/breaks or capacity invalidates the corresponding verification unless the same authenticated edit explicitly re-verifies it. Provisional tire/cabin-filter/wiper services cannot be automatically confirmed even when settings are verified. Brake/AC/Other repairs always require approval. When the automatic limit is reached, an otherwise valid request remains pending with a provisional hold. Email receipts reflect actual automatic confirmation when it happens; pending receipts never imply approval. No live settings were enabled during development.

## API contract

| Method and route | Access / purpose |
| --- | --- |
| `GET /api/availability?service=Oil%20Change&date=YYYY-MM-DD` | Public sanitized slots and policy metadata; no customer fields, IDs, counts, or block reasons |
| `POST /api/appointments` | Existing public request body; validates again and reserves atomically; 201 only after the record saves |
| `PATCH /api/mechanic/appointments/:id` | Existing mechanic session + CSRF; `{status:"confirmed"}` rechecks and acquires capacity; `{status:"declined"}` releases |
| `GET /api/mechanic/scheduling/settings` | Mechanic session; `{revision, settings}` |
| `PATCH /api/mechanic/scheduling/settings` | Mechanic session + CSRF; `{revision, settings: partialPatch}`; stale settings revision -> 409 |
| `POST /api/mechanic/scheduling/blocks` | Mechanic session + CSRF; `{startAt, endAt, reason?}` -> 201 with generated block ID |
| `DELETE /api/mechanic/scheduling/blocks/:id` | Mechanic session + CSRF; removes a block |

Availability returns `{date,service,timezone,durationMinutes,slots,policy,settingsProvisional,message}`. Slots contain only `{time,startAt,endAt,durationMinutes}`. Closed/out-of-window/occupied dates return an empty slots array; malformed dates/services return 400. Booking/approval conflicts return 409 with a safe message and error code. Busy/database failures fail closed. The public availability response exposes no names, phones, emails, notes, appointment identifiers, or private blocked-period reasons. The existing POST response still returns the submitting customer’s own reference ID.

The future dashboard can edit `weeklyHours` (0=Sunday … 6=Saturday, arrays of `{start,end}`), daily `breaks`, `closedDates`, `blockedPeriods`, capacity, notices, horizon, grid, buffers, hold length, service rules, and verification flags without a schema redesign. Unknown keys, invalid types, unsafe ranges, and invalid intervals are rejected. Working intervals cannot cross local midnight; use separate per-day intervals. Settings APIs are ready, but no new staff settings screen or rescheduling/cancellation UI is included.

## Minimal customer compatibility

The existing appointment page retains its service deep links and review/send flow. After service/date selection it loads available request times instead of accepting unrestricted free-text times, shows timezone and estimated duration, explains placeholder settings and pending holds, cancels stale fetches, and refreshes after a 409. This is a small compatibility step, not the future calendar UI. Shared input validation has an opt-in scheduling-authoritative mode so browser-local time and the old Sunday rule cannot override persisted shop settings; the API remains authoritative.

## Development and validation

Use the existing isolated checkout, Node/npm, and local MongoDB prepared by onboarding. Start the retained `mechanic-shop-mongo` container, confirm `mongosh` ping, then run:

```sh
npm test --prefix server
node --test shared/services.test.js src/utils/appointmentValidation.test.js
npm run lint
npm run build
```

`npm test --prefix server` now includes real MongoDB integration tests. They require local MongoDB at `mongodb://127.0.0.1:27017` or `TEST_MONGODB_URI`; they fail clearly if it is unavailable instead of silently skipping. Each test creates and drops **only** its own random `eds_scheduling_test_<UUID>` database. They never use or drop the application database. Critical concurrency tests instantiate two independent coordinators against the same real models.

Start the API with `cd server && npm start`, and Vite from the root with `npm run dev -- --host 0.0.0.0 --port 5173 --strictPort`. Keep SMTP unset for synthetic local checks. External Brevo delivery is not tested here; its dispatcher/session protections are retained and notification tests cover pending/automatic receipts and retry behavior.
