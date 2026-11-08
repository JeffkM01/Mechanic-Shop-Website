# Scheduling and availability

## Safe development defaults

The first API startup seeds one MongoDB `schedulingstates` document (`_id: "shop"`). Subsequent starts **preserve** saved settings. One compatibility correction upgrades previously saved repair/diagnostic rules with `requiresApproval: false` to `true` under the same MongoDB revision guard. This fixes earlier PR #9 defaults, increments the settings revision, and preserves hours, capacity, estimates, and automatic-booking/verification flags. Defaults are editable placeholders, not confirmed business information:

| Setting | Default |
| --- | --- |
| Timezone | America/Chicago |
| Hours | Monday–Friday, 8:00 AM–5:00 PM; Saturday/Sunday closed |
| Daily break | 12:00 PM–1:00 PM |
| Simultaneous capacity | 1 |
| Daily automatic confirmations | At most 3 |
| Minimum customer notice | 24 elapsed hours |
| Booking horizon | Through shop-local today + 14 calendar days, inclusive |
| Start grid | 30 minutes, aligned to local midnight |
| Buffer | 15 minutes after each appointment |
| Pending hold | 24 elapsed hours from reservation |
| Automatic booking | **Disabled** |
| Hours/capacity verified | **Both false** |

Cabin filter, engine filter, and wiper booking estimates are 30 minutes; tire rotation and oil change are 60; engine diagnostics is 90. Brake, AC/heating, and Other / Not Sure have editable 120-minute placeholders. **All Repairs & Diagnostics services, including Engine Diagnostics, always require mechanic approval**; settings updates cannot disable that category policy. These estimates reserve time, not guaranteed repair completion times. The existing shared service catalog remains the source of accepted names and provisional service flags.

Both the service duration **and buffer** must fit inside one work interval and avoid lunch, closures, and blocked periods. For example, an hour-long visit at 11:00 AM is unavailable because its buffer would cross into lunch. No US holiday assumptions are invented: Edward must enter `closedDates` or blocked periods.

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
- Confirming an expired request requires acquiring capacity again; a conflict returns HTTP 409 and leaves the request pending. Approval may occur inside the original 24-hour notice window or beyond a subsequently shortened horizon. Historical requests at off-grid times such as 08:15 may be approved: the configured start grid applies to new customer bookings, not manual approval of existing requests. Approval must still be future, obey current working hours, breaks, closures, blocked periods, duration/buffer and timezone constraints, and fit capacity. New customer submissions and public slots continue to enforce the configured grid.
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
- a non-provisional **Basic Maintenance** service whose scheduling rule permits automatic approval;
- a newly revalidated, atomically reserved slot and an available daily automatic-admission place.

Enabling the flag alone cannot confirm using placeholder hours/capacity. Editing saved hours/timezone/breaks or capacity invalidates the corresponding verification unless the same authenticated edit explicitly re-verifies it. Provisional tire/cabin-filter/wiper services cannot be automatically confirmed even when settings are verified. Every Repairs & Diagnostics service (Brake Repairs, AC & Heating Repair, Engine Diagnostics, and Other / Not Sure) always requires approval. This list is derived from the shared catalog category, so new repair-category entries cannot accidentally become automatic. When the automatic limit is reached, an otherwise valid request remains pending with a provisional hold. Email receipts reflect actual automatic confirmation when it happens; pending receipts never imply approval. No live settings were enabled during development.

## Customer notification policy

`decisionCustomer` is the **only customer-confirmation queue for automatic bookings**. Automatic approval atomically changes a still-pending `requestCustomer` receipt to `suppressed` while setting confirmed status and queuing `decisionCustomer`. If the initial pending receipt was already sent, its `sent` state is preserved and only the decision confirmation is queued. A receipt already in flight may finish with its pending message; it is followed by one logical confirmation rather than two different confirmation messages.

The dispatcher also suppresses unsent request receipts on automatically confirmed records queued by older PR revisions. It does not suppress the mechanic notice. The request-receipt template refuses automatic-confirmation use, preventing an alternate confirmation path. Manual approval is unchanged: the pending receipt and mechanic notice are sent normally, then Edward's confirmed/declined decision is queued after review.

This removes duplicate **logical confirmation paths**. Existing SMTP retry semantics remain at-least-once: provider acceptance followed by a failed state acknowledgement can still cause a retry. Tests use injected transports only; no external customer email is sent during validation.

## API contract

| Method and route | Access / purpose |
| --- | --- |
| `GET /api/availability?service=Oil%20Change&date=YYYY-MM-DD` | Public sanitized slots and policy metadata; no customer fields, IDs, counts, or block reasons |
| `GET /api/availability/calendar?service=Oil%20Change&month=YYYY-MM` | Public month summary and shop-local booking bounds; `month` is optional and defaults to the current shop-local month |
| `POST /api/appointments` | Existing public request body; validates again and reserves atomically; 201 only after the record saves |
| `PATCH /api/mechanic/appointments/:id` | Existing mechanic session + CSRF; `{status:"confirmed"}` rechecks and acquires capacity; `{status:"declined"}` releases |
| `GET /api/mechanic/scheduling/settings` | Mechanic session; `{revision, settings}` |
| `PATCH /api/mechanic/scheduling/settings` | Mechanic session + CSRF; `{revision, settings: partialPatch}`; stale settings revision -> 409 |
| `POST /api/mechanic/scheduling/blocks` | Mechanic session + CSRF; `{startAt, endAt, reason?, revision?}` -> 201 with generated block ID; stale optional revision -> 409 |
| `DELETE /api/mechanic/scheduling/blocks/:id` | Mechanic session + CSRF; optional JSON `{revision}`; removes a block only if the supplied revision is current |

Availability returns `{date,service,timezone,durationMinutes,slots,policy,settingsProvisional,message}`. Slots contain only `{time,startAt,endAt,durationMinutes}`. Closed/out-of-window/occupied dates return an empty slots array; malformed dates/services return 400. Booking/approval conflicts return 409 with a safe message and error code. Busy/database failures fail closed. The public availability response exposes no names, phones, emails, notes, appointment identifiers, or private blocked-period reasons. The existing POST response still returns the submitting customer’s own reference ID.

### Month summaries

The calendar endpoint supplements the existing single-day endpoint; it does not change the booking or approval rules. A valid shared-catalog service is required. Legacy service aliases such as `Air Filter Change` are accepted and the response uses the canonical name. A supplied month must be one `YYYY-MM` value within the months touched by the current booking window. Malformed, duplicate, or out-of-range month parameters return 400.

The response contains only:

```js
{
  service, month, timezone,
  today, firstDate, lastDate,
  durationMinutes, policy, settingsProvisional,
  days: [{ date, available }],
  generatedAt
}
```

`today` and `firstDate` are the server clock's current date in the persisted shop timezone. `lastDate` is that date plus the currently configured `bookingHorizonDays`, inclusive; the UI does not assume 14 days. Dates use `YYYY-MM-DD`, `month` uses `YYYY-MM`, and `generatedAt` is an ISO UTC timestamp. Date-only arithmetic uses UTC calendar operations so leap dates, month boundaries, daylight-saving changes, and a customer timezone different from the shop cannot shift the selected date. These UTC operations do not reinterpret shop appointment times as UTC.

`days` includes only dates both in the requested month and within `[firstDate, lastDate]`, with at most 31 entries. A date is available only when the existing slot calculator finds at least one start time after applying service duration, notice, hours, breaks, closures, blocks, buffers, provisional holds, confirmed appointments, and capacity. The summary uses one scheduling-state snapshot and one occupancy query for the whole month, rather than a MongoDB query per date. It exposes no slots, customer information, appointment IDs/counts, reservations, or private block reasons. `false` means no currently available start times; it does not identify whether the day is closed, occupied, blocked, or outside the notice window.

The shared `policy` fields are `minimumNoticeHours`, `bookingHorizonDays`, `pendingHoldHours`, `startIncrementMinutes`, `bufferMinutes`, `automaticBookingEnabled`, `businessHoursVerified`, and `capacityVerified`. `settingsProvisional` is true when hours or capacity have not been verified. Calendar reads do not change booking settings or reservations; the existing first-read initialization and compatibility correction described above still apply.

Both availability endpoints send `Cache-Control: no-store`. A displayed result is a point-in-time observation, not a reservation or promise. The existing POST endpoint revalidates and atomically reserves against the latest settings and occupancy even if availability was fetched immediately before submission.

The protected staff dashboard edits `weeklyHours` (0=Sunday … 6=Saturday, arrays of `{start,end}`), recurring shop-wide `breaks`, `closedDates`, capacity, notices, horizon, grid, buffers, hold length, service rules, timezone, and verification flags through the existing settings API. Blocked periods use their dedicated endpoints. Unknown keys, invalid types, unsafe ranges, and invalid intervals are rejected. Working intervals cannot cross local midnight; use separate per-day intervals. A closing boundary of `24:00` means midnight at the start of the following date and is labeled accordingly. No new appointment rescheduling/cancellation or confirmed-appointment deletion behavior is introduced.

## Customer calendar and booking flow

The appointment page uses four steps: choose a service, choose a date/time, enter customer/vehicle details, and review/send. Service categories, accepted names, provisional labels, and service-card preselection come from the existing shared catalog. Changing the service clears the selected date/time; changing the date clears the time. Customer details remain in React memory through these changes and conflict recovery, without writing them to browser storage.

The month calendar distinguishes today, selected, available, unavailable, and loading dates using text/symbols as well as color. Dates cannot be selected until the API says they are available. Month controls stay inside server-provided bounds. The calendar has weekday headings, labeled date buttons, visible focus, loading/error announcements, and keyboard movement: arrow keys by day/week, Home/End within the week, and Page Up/Page Down between supported months. Desktop layouts place the calendar and times alongside one another; narrower layouts stack them.

Selecting a day loads the unchanged single-day endpoint. Only its returned slots appear as selectable Morning/Afternoon buttons in 12-hour format. No time is selected automatically. The shop timezone and estimated duration appear beside the choices and in the review summary; durations are not guaranteed repair completion times. An empty day displays: “No appointment times are available for this date. Please choose another day.” The UI does not infer that it is fully booked.

`useBookingAvailability` makes one bounded month request instead of requesting every day separately, plus a single selected-day request when needed. It keeps a short, 30-second in-memory cache for navigation, bypasses HTTP caches, aborts superseded requests, and ignores late responses for old services, dates, or views. Calendar and day requests have separate controllers; there is no concurrent fan-out across dates. Loading and failure states offer explicit retry controls, and returning focus to the window refreshes the calendar. Availability is always presented as subject to change.

Review validates the existing customer fields and performs a fresh, uncached day check before showing the full service/date/time/timezone/duration/customer/vehicle/notes summary. **Edit Details** returns to the form. **Send Appointment Request** is the only submission action and performs another fresh day check before the existing `POST /api/appointments`. Client checks improve recovery; the server remains authoritative and applies its atomic reservation protection. Shared validation uses its scheduling-authoritative mode so the browser's current date/time and old Sunday restriction cannot override saved shop rules.

The review also snapshots the selected slot's UTC start/end, timezone, and estimated duration. If the fresh send-time check returns different values, the page stops before POST, keeps the customer's details, and requires review of the updated scheduling information. An unchanged wall-clock label such as 8:00 AM cannot silently approve a different timezone or booking duration.

A missing slot or HTTP 409 clears the selected time and review, refreshes calendar/day availability, explains the conflict, and preserves contact information, vehicle details, and notes. The customer can choose another available time and review again. Errors do not silently submit or automatically retry a booking.

Successful responses are displayed according to the saved server status. Pending requests say: “Your appointment request has been received and is awaiting mechanic approval. Your appointment is not confirmed yet.” The page shows the reference ID and, when supplied, the hold expiration formatted in the shop timezone, explaining that the request remains on file after expiry. Confirmed wording is shown only for an explicit `confirmed` server response. Existing mechanic review, MongoDB persistence, session/CSRF protection, and email queue/retry behavior are preserved.

The calendar does not edit business settings or enable automatic booking. **Automatic booking remains disabled by default**, hours/capacity remain unverified placeholders, and provisional services remain subject to Edward's confirmation. Edward must verify real hours, capacity, service availability, and booking-duration estimates before enabling eligible Basic Maintenance automation through the existing protected settings workflow. Repairs & Diagnostics always require mechanic approval.

## Mechanic scheduling dashboard

Sign in at `/mechanic` using the existing Staff Login link. The authenticated workspace separates appointment management from **Business Hours**, **Closures & Blocked Times**, and **Booking Settings**. Unauthenticated visitors see only the sign-in screen. Settings are fetched lazily when an authenticated staff member first opens a scheduling section, and reused across section navigation within that session. Opening the dashboard never replaces stored settings with placeholders.

**Appointments** preserves pending/confirmed/declined/all filters, customer contact/vehicle/notes, and the existing Confirm/Decline actions. A conflicting approval displays the server error and leaves the request pending. Notification queue/retry behavior is unchanged. Existing request date/time strings, duration snapshots, and status semantics remain in storage.

**Business Hours** provides an Open/Closed control for every weekday and supports up to 24 non-overlapping work intervals per day. Add or remove intervals and edit opening/closing times in AM/PM. A closed weekday has no working intervals and offers no customer appointments. Closing must follow opening within one shop day; invalid or overlapping intervals cannot be saved. The recurring-break editor supports up to 24 non-overlapping daily breaks. These breaks apply **shop-wide on every open day**, not to selected weekdays or individual staff. The interface makes this limitation explicit rather than changing the scheduling schema.

**Save Changes** validates the draft and opens a review showing each changed field with its saved and proposed values. Nothing is written at this step. **Confirm Changes** applies the reviewed partial patch through the existing `{revision, settings: partialPatch}` contract; **Keep Editing** returns to the draft without saving. **Discard Changes** restores the saved snapshot. Unsaved changes are visibly distinguished from saved values, and the review explains the customer-availability impact before any PATCH is sent. Backend validation is authoritative: a proposed closure, break, working-hours change, timezone change, or capacity reduction that conflicts with held/confirmed work returns a clear error and preserves saved settings and appointments.

**Closed Dates** accepts a strictly validated `MM/DD/YYYY` date, lists dates chronologically, prevents duplicates, and requires an explicit removal confirmation. Adding or removing a closure changes the draft; Save Changes followed by Confirm Changes is still required. Federal holidays are never inserted automatically. Removing a closure may make its date available under the other saved rules.

**Blocked Time** accepts start/end dates and AM/PM times plus an optional staff-only reason of up to 200 characters. Start and end may fall on different dates. The browser resolves each wall-clock choice using the **persisted shop timezone**, converts it to UTC ISO for `POST /api/mechanic/scheduling/blocks`, and rejects missing or ambiguous clock-change times. The resolver is shared with the existing backend so browser and server do not guess different DST offsets. Existing blocks are sorted chronologically and displayed in the shop timezone. Removing a block requires explicit confirmation and uses `DELETE /api/mechanic/scheduling/blocks/:id`.

Block changes save immediately through those dedicated endpoints and then load their new settings revision. The staff UI sends the revision of the saved configuration used to resolve the wall-clock inputs: `revision` in the POST body and `{revision}` in the DELETE body. These optional values must be non-negative integers. The existing MongoDB compare-and-swap checks the precondition **inside each atomic mutation attempt**, including every retry. If another process changed the timezone or any settings after the form loaded, `SETTINGS_CHANGED` rejects the stale block operation before writing. This prevents a Chicago-derived UTC instant from silently becoming a different local appointment block after a concurrent timezone change.

The revision precondition is an additive extension to the existing block endpoints and reservation coordinator; no new scheduling infrastructure, database schema, or booking rules are introduced. Older callers that supply UTC instants directly may continue omitting the optional revision and retain their original POST/DELETE contract. The revision is a request precondition, not stored blocked-period data.

A stale-revision block error locks further block/settings mutations until **Reload Latest Settings** succeeds. Local start/end date, time, and reason inputs remain available for correction and review; after reload, the same wall-clock choices are resolved again using the newly saved timezone before any explicit resubmission. A successful removal likewise refreshes the saved revision. If a block may have committed but its response or follow-up settings read fails, further mutations are locked until **Reload Latest Settings** succeeds; the UI does not guess whether it should replay the block operation. Edward must review the refreshed list before making another block change. Save or discard any ordinary settings edits before managing blocks; the UI disables block actions while such edits remain, avoiding a block refresh overwriting an unsaved draft or using an unsaved timezone. A conflicting block displays the server's error without releasing appointments. Block reasons remain visible only in the protected staff settings response; neither public availability endpoint exposes them.

**Booking Settings** exposes these existing integer constraints:

| Control | Allowed values |
| --- | --- |
| Simultaneous capacity | 1–20 |
| Maximum automatic confirmations per day | 0–100 |
| Minimum advance notice | 0–720 hours |
| Booking horizon | 1–365 calendar days |
| Appointment start increment | 5–120 minutes; must divide 1,440 evenly |
| Appointment buffer | 0–120 minutes |
| Pending request hold duration | 1–168 hours |
| Service booking estimate | 5–720 minutes |

Service names/categories/provisional flags come from the shared catalog. Estimate changes affect new availability, not historical held/confirmed duration and buffer snapshots. The legacy unknown-service estimate remains an existing backend compatibility setting; this dashboard does not rewrite old service names or expose a separate unknown-service catalog entry.

### Explicit verification and automatic-booking safety

The dashboard shows the saved/draft automation and verification state, with separate acknowledgments for real operating hours/timezone/breaks and actual simultaneous capacity. It does not auto-check these acknowledgments. Editing hours/timezone/breaks clears hours verification; editing capacity clears capacity verification. Edward must explicitly verify the changed information again.

Enabling automatic booking is unavailable until both acknowledgments are present and requires a separate confirmation explaining its consequences. That confirmation changes the draft only; Save Changes and then Confirm Changes are still required to apply the reviewed configuration. Opening the page, editing an unrelated setting, or saving does not itself enable automation. Disabling automation is available without removing other business settings.

Only non-provisional Basic Maintenance services can be made eligible; Edward may additionally require their manual approval. The UI provides no override for Repairs & Diagnostics or provisional services. All Repairs & Diagnostics, including Engine Diagnostics, always require mechanic approval at the backend. Provisional services remain ineligible for automatic confirmation even if their stored `requiresApproval` flag is false. The customer page displays only the status actually saved by the server.

### Revision conflicts and private-state lifetime

Settings PATCH requests include the loaded `settingsRevision`. If another administrator or a dedicated block mutation changed the configuration, HTTP 409 with `SETTINGS_CHANGED` prevents overwrite. The dashboard keeps the unsaved draft and offers **Reload Latest Settings**. Loading the latest snapshot does not automatically save or replay the draft. It identifies overlapping changes and requires **Review with Latest Settings** before the preserved edits are applied to the newer saved snapshot. Unrelated newer values are retained; overlapping fields use the displayed local edits only after this explicit action. Save Changes and Confirm Changes are still required afterward, so reload and rebase never write automatically. Discard is available to adopt the latest saved values instead. Hours/capacity verification must be renewed when a changed configuration makes a prior acknowledgment unsafe.

The existing `useMechanicSession` remains the only staff session mechanism. Settings and appointments use the HTTP-only cookie; modifying requests include its in-memory CSRF token. No credentials or CSRF tokens are written to browser storage. Unauthorized reads/writes, invalid CSRF tokens, server errors, and reservation conflicts remain server-enforced. Session expiry, sign-out, and browser session revalidation discard the private workspace and in-flight UI work. Background reads do not renew inactivity time.

## U.S. date/time display and unchanged storage

Visible customer and mechanic scheduling dates use **MM/DD/YYYY**, and times use **12-hour AM/PM** notation explicitly formatted with the U.S. locale. This includes calendar date labels/selection, request review and success, hold expiration, appointment cards, closures, and blocked periods. Calendar month headings remain readable month/year labels and grid cells remain day numbers. Date/time fields use explicitly formatted text with strict validated conversion, avoiding native date/time controls whose presentation depends on the visitor's locale.

`src/utils/bookingDates.js` is the shared frontend formatting/parsing entry point. Strict display-date parsing rejects impossible dates such as `02/29/2027` or `04/31/2027`; valid leap dates round-trip to the same ISO calendar date. Date-only values use Gregorian calendar arithmetic and are never interpreted as an ordinary local timestamp. Actual timestamps are formatted in the configured shop timezone; new appointment snapshots preserve their original timezone.

Display conversion never changes the wire/storage contract: date-only API/MongoDB values remain `YYYY-MM-DD`, API clock times remain `HH:MM`, and actual UTC timestamps remain ISO 8601. No schema stores presentation strings. The extracted `shared/shopTime.js` wall-clock resolver preserves the server's strict timezone, missing-time, and repeated-time behavior and is reused for staff-entered block conversion. Both DST spring gaps and fall folds require correction rather than an assumed offset.

## Development and validation

Use the existing isolated checkout, Node/npm, and local MongoDB prepared by onboarding. Start the retained `mechanic-shop-mongo` container, confirm `mongosh` ping, then run:

```sh
npm test --prefix server
npm test
npm run lint
npm run build
npm run test:browser
```

`npm test --prefix server` now includes real MongoDB integration tests. They require local MongoDB at `mongodb://127.0.0.1:27017` or `TEST_MONGODB_URI`; they fail clearly if it is unavailable instead of silently skipping. Each test creates and drops **only** its own random `eds_scheduling_test_<UUID>` database. They never use or drop the application database. Critical concurrency tests instantiate two independent coordinators against the same real models.

`npm test` runs the existing shared service/appointment-validation tests and the new pure date/calendar utility tests using Node's test runner, with no added unit-test framework. The calendar tests cover weekday alignment, leap dates, month/year boundaries, timezone conversion, horizons, and 12-hour labels. Backend month-API regressions compare summaries with single-day slots, count bounded database reads, verify dynamic horizons/leap dates/both daylight-saving transitions, and check privacy, invalid input, public access, and unchanged stored settings.

`npm run test:browser` uses the development-only `@playwright/test` and `axe-core` packages and runs all customer and mechanic browser specs. Install Chromium once with `npx playwright install chromium` if no browser is available; the config also uses `/usr/bin/chromium` when installed, or `PLAYWRIGHT_CHROMIUM_EXECUTABLE` for an explicit path. Playwright starts Vite on port 5174 and runs Chromium at desktop (1440×1000), tablet (768×1024), and mobile (390×844) widths. Firefox and WebKit are outside this automated browser coverage.

`tests/booking-calendar.spec.js` mocks availability and booking responses, requires no MongoDB or SMTP, and sends no real customer requests or emails. Run only these tests with `npm run test:browser -- tests/booking-calendar.spec.js`. They exercise API-provided slots, resets, loading/empty/error/retry states, stale responses, request counts, keyboard navigation, explicit review/send, pending/confirmed messages, scheduling-metadata changes between review/send, conflict recovery with preserved details, overflow/touch-target checks, and an automated WCAG accessibility audit.

`tests/booking-calendar.integration.spec.js` requires the same local MongoDB or `TEST_MONGODB_URI` as the backend integration suite. Each test owns a random `eds_calendar_browser_test_<UUID>` database, starts an isolated Express API with notifications explicitly disabled, and routes all browser API traffic to that server. It never loads the application's `.env`, touches the normal shop database, or creates an email transport. It verifies a customer request remains pending and persists correctly, appears in the existing mechanic dashboard, receives a CSRF-protected manual confirmation, and becomes inaccessible after logout (private reads return 401). It also verifies saved scheduling settings remain unchanged. Cleanup verifies the database's random test prefix before dropping only that test database.

`tests/mechanic-scheduling.spec.js` and `tests/mechanic-fixture.js` exercise the staff workflow against real isolated Express/MongoDB instances. Run this spec alone with `npm run test:browser -- tests/mechanic-scheduling.spec.js`. Each test creates and removes only its own random `eds_dashboard_browser_test_<UUID>` database, uses synthetic customer information and disabled notifications, and intercepts every browser API request so no request reaches the normal shop backend. The tests deliberately use a non-U.S. browser locale and a timezone different from the shop, while verifying numeric U.S. dates, AM/PM display, and shop-local UTC block conversion. No new test dependencies or production credentials are required beyond the existing MongoDB/Chromium setup.

The backend suite also covers the staff settings API workflow: persisted split hours/closed weekdays/breaks, closure/block lifecycle and privacy, revision conflicts with explicit partial retry, policy/duration updates retaining historical snapshots, and configuration/block conflicts that leave reservations and appointments unchanged. Block revision regressions verify stale-timezone rejection with no write, fresh timezone conversion after reload, a forced concurrent timezone/block CAS race, invalid preconditions, guarded removal, and backward-compatible UTC-only clients. The dashboard browser suite extends coverage to editing, confirmation safeguards, revision recovery, private-state clearing, responsive layouts, and U.S. date/time display. All tests use synthetic customers and isolated data. Tests may exercise automation flags only in isolated fixtures; they do not enable automatic booking or change actual shop settings. External Brevo delivery remains untested.

Final Prompt 4 validation passed **117 backend tests**, **48 frontend/shared tests**, and **102 browser cases** (57 customer calendar cases, three real booking/dashboard cases, and 42 staff scheduling cases) across desktop, tablet, and mobile widths. ESLint, the production build, and whitespace checks passed. Automated WCAG 2 A/AA and 2.1 AA audits reported no violations and no horizontal overflow. Chromium layouts were visually reviewed; manual Firefox/Safari and assistive-technology checks remain outside this run, as does live Brevo delivery.

Start the API with `cd server && npm start`, and Vite from the root with `npm run dev -- --host 0.0.0.0 --port 5173 --strictPort`. Keep SMTP unset for synthetic local checks. External Brevo delivery is not tested here; its dispatcher/session protections are retained and notification tests cover pending/automatic receipts and retry behavior.
