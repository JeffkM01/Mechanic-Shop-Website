# Customer appointment management and cancellation

## Initial business policy

This release adds cancellation, not rescheduling or customer accounts. The initial policy is **provisional and requires Edward's confirmation before deployment**: customers and staff can cancel a future pending or confirmed appointment until its scheduled start. There is no invented cancellation fee or 24-hour cancellation cutoff. After the scheduled start, or when a request has been declined, the customer must contact the shop. An already-cancelled appointment remains visible without another state change.

The backend decides eligibility using its clock and the appointment's recorded UTC start/timezone where available. A pending reservation's hold may have expired; that does not prevent cancelling the still-future request. Historical local dates/times use the existing strict shop-time resolver. An unusable, missing, or ambiguous appointment start fails safely rather than guessing eligibility. Working-hour estimates, service availability, actual shop contact details, and automatic-booking eligibility remain subject to the existing verification requirements. Automatic booking remains disabled by default.

## Customer workflow

Eligible customer emails include a **Manage appointment** link when secure link generation and outgoing email are configured. The customer opens `/manage-appointment`, reviews the service, vehicle, original date/time, timezone, and saved status, then chooses **Cancel appointment**. Opening the confirmation does not change the appointment.

The confirmation offers optional reasons and a bounded optional message. Customers do not have to explain their decision. **Keep appointment** closes the confirmation; **Confirm cancellation** submits the request. Success appears only after the server confirms the saved terminal status. Notification text describes queued/disabled notification state and does not promise that an email has already been delivered.

If a cancellation response is lost or ambiguous, refresh the appointment status before trying again. A retry of an already-saved cancellation returns the original result and does not change its explanation, timestamp, or notification events. A failed read does not prove that a cancellation failed. A missing, expired, invalid, or revoked link gives a generic contact-shop fallback; there is no public appointment-ID/email lookup or automatic historical backfill.

Customer views expose only the appointment information needed for this workflow and customer-facing decision/cancellation text. They omit customer names, phone numbers, email addresses, private notes, management credentials, and reservation internals. An appointment reference by itself is not an authorization credential.

## Scoped links and sessions

A management link is a bearer credential: anyone possessing it can view and cancel that one appointment within the supported policy. Treat it as sensitive and do not forward it or paste it into screenshots, issue trackers, analytics, or logs. The email contains a token in the URL **fragment**, so an ordinary HTTP request does not send the token to the web server as a query parameter. The client removes the fragment with `history.replaceState` before exchanging it and keeps only a nonsensitive appointment reference in the URL for refresh.

New appointments receive a grant only when link generation is safely enabled. A CSPRNG nonce and an external secret produce an appointment-bound HMAC bearer. MongoDB stores the nonce, token verifier, key identifier, expiry/revocation metadata, and hashed limited-session credentials; it does not store raw bearer tokens. The external key allows the email worker to derive the same link for a queued retry without storing a plaintext or reversibly encrypted bearer in the appointment. The verifier is compared in constant time after format validation.

Links expire **30 elapsed days after issuance**. Exchanging a valid link creates an appointment-scoped session with a **20-minute absolute lifetime**, bounded by the grant expiry. At most five sessions are retained per appointment. The random session credential is carried in an HttpOnly, SameSite Strict cookie scoped to that appointment's API path, with Secure enabled for HTTPS/production. MongoDB stores only its hash. A second appointment tab cannot silently replace the first tab's authorization scope. No session credential or bearer is stored in localStorage or sessionStorage.

Every authorized request rechecks the original grant's expiry, revocation, and key identifier. Expiration, staff revocation, or key rotation invalidates its limited sessions as well as its link. Customer sign-out revokes the stored session and clears the cookie; deleting client state alone is not the security boundary. A refresh without an active session requires the original valid email link again.

Customer mutations require the configured website Origin and a session-bound CSRF token kept only in React memory and sent in a dedicated header. The initial exchange also requires the configured Origin. The session cannot authorize staff APIs or another appointment. Responses carrying appointment/session information, including authentication errors, use `Cache-Control: no-store` and `Referrer-Policy: no-referrer`. The page also uses a no-referrer policy; deployment middleware and any analytics must preserve these protections and avoid recording fragments, exchange bodies, cookies, or CSRF tokens.

Exchange attempts are rate limited by a bounded, process-local IP limiter. Invalid, expired, revoked, and unknown links receive a generic failure rather than confirming that an appointment exists. For multiple API instances, configure a trusted edge/proxy rate limit or a shared limiter; separate process counters do not provide a global abuse limit. Set proxy trust only for the actual trusted proxy chain so clients cannot choose their apparent source address.

## Configuration and operations

Leave the following unset until the deployment origin and SMTP delivery are ready:

| Variable | Requirement |
| --- | --- |
| `PUBLIC_WEBSITE_ORIGIN` | Explicit origin only, such as `https://shop.example`; no credentials, path, query, or fragment. HTTPS is required except for an explicit HTTP loopback origin with `NODE_ENV=development` or `NODE_ENV=test`. Production rejects loopback origins. No localhost fallback is generated. |
| `APPOINTMENT_MANAGEMENT_SECRET` | At least 32 cryptographically random bytes encoded as base64/base64url, stored outside MongoDB and outside source control. No default is supplied. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`, `MECHANIC_NOTIFICATION_EMAIL` | All six existing email settings must be present for new link issuance. SMTP must actually be working; configuration presence alone does not establish deliverability. |

Generate a new secret locally with `openssl rand -base64 32`, then put the result directly in the deployment secret store or private server environment. Do not commit, print in diagnostics, or include an actual key in a pull request. Production email links use the explicitly validated origin, never the incoming Host or forwarded-host header. Invalid/missing origin, missing secret, or incomplete email settings disables new grants and management links; booking itself still works with an honest contact-shop fallback. SMTP failures leave durable queue entries for retry.

Changing the management secret rotates the key and invalidates existing management links and limited sessions. This release does not retain old rotation keys, silently issue replacement links for historical records, or implement verified-email recovery. Coordinate rotation with customer support. An authenticated mechanic can revoke one appointment's management grant using `POST /api/mechanic/appointments/:id/management/revoke` with the existing mechanic CSRF protection. Revocation does not cancel or delete the appointment. Keep the database and external secret protected independently; possession of both can reconstruct links for unexpired grants.

Before deployment, verify the real HTTPS origin, reverse-proxy/TLS/cookie configuration, SMTP sender and mailbox, Edward's notification address, actual customer contact details, and the provisional cancellation policy. Do not turn on automatic booking or mark hours/capacity verified as part of this setup.

Serve the frontend and `/api` under that same public origin. The host must serve the React application for a direct visit to `/manage-appointment` while forwarding `/api/customer/appointments/...` to Express; do not rewrite API failures to the SPA. Preserve Origin, Set-Cookie, no-store, and referrer-policy headers through the proxy, and exclude these routes and exchange bodies from analytics or request-body logging.

## API boundaries

| Route | Authorization and purpose |
| --- | --- |
| `POST /api/customer/appointments/:id/exchange` | Valid scoped bearer in JSON plus configured Origin; creates limited customer session. |
| `GET /api/customer/appointments/:id` | Scoped customer cookie; returns minimal saved state and cancellation eligibility. |
| `POST /api/customer/appointments/:id/cancel` | Scoped customer session, configured Origin, and customer CSRF; optional bounded reason/message. |
| `POST /api/customer/appointments/:id/logout` | Scoped customer session, configured Origin, and customer CSRF; revokes that session. |
| `POST /api/mechanic/appointments/:id/management/revoke` | Existing mechanic session and CSRF; invalidates link and all its sessions. |
| `POST /api/mechanic/appointments/:id/cancel` | Existing mechanic session and CSRF; saves reviewed reason and customer-facing explanation. |

The mechanic cancellation action preserves the existing review endpoint and uses the existing staff session/CSRF checks. Public availability remains sanitized: it exposes no customer details, appointment identifiers, cancellation explanations, or management metadata. Customer authorization is not accepted by mechanic routes.

## Staff workflow and retained records

The mechanic dashboard adds **Cancel appointment** for eligible pending and confirmed appointments and a **Cancelled** filter/history state. Cancellation differs from declining an unaccepted request. The dialog requires a reason and a meaningful customer-facing explanation, displays the resulting message for review, and requires **Confirm cancellation**. **Keep appointment** preserves the appointment. All cancellation reads/mutations stay behind the existing mechanic session checks, CSRF validation, inactivity timeout, and sign-out protections.

Saved records retain the original service/date/time and the `cancelled` status. Their bounded cancellation metadata records the actor, reason, optional customer message or required staff explanation, cancellation timestamp, original local date/time, and timezone. Cancelled cards show the actual recorded history and no Confirm/Decline actions. The existing latest-100 appointment view remains; cancellation does not delete records or introduce an unbounded public history.

Management reads use the appointment's existing `_id` index and then verify its scoped grant/session. No TTL deletion index is added: expiration denies access without deleting the appointment or its cancellation history. Management metadata is excluded from default queries, and existing records are not backfilled.

## Reservation integrity and failure ordering

Cancellation conditionally changes only an eligible pending/confirmed record to the terminal `cancelled` state, saving metadata and notification intent in that same appointment write. It then releases only that appointment's reservation through the existing MongoDB scheduling-state compare-and-swap protocol. It never releases capacity before the terminal record is durable, resets other reservations, or refunds historical automatic-admission counters.

Cancelled records are terminal in both ledger reconciliation and legacy occupancy calculations. If reservation cleanup fails or the API process stops after the appointment write, authoritative availability reads ignore the stale reservation for that cancelled record; later scheduling mutations reconcile it. If the terminal write fails, the original reservation stays occupied. Approval/decline predicates cannot resurrect a cancelled record, and repeated or concurrent cancellations return the saved outcome without replacing metadata or requeuing notification events. Standalone MongoDB remains supported without adding transaction/replica-set requirements. See [Scheduling and availability](scheduling.md) for the existing two-document conservative failure policy.

## Notification semantics

Customer cancellation queues an acknowledgement to the customer and a cancellation notice to the mechanic. Staff cancellation queues a customer notice containing the saved explanation. The cancellation and queue intent persist even when SMTP is disabled, delivery fails, or reservation cleanup fails; notification failure never restores an appointment. Messages use saved values, U.S. dates, AM/PM times, and the recorded shop timezone. User-entered text appears only in the plain-text message body, not email headers.

Unsent pending/confirmation customer messages are suppressed after cancellation. Previously sent flags are preserved. Before sending a queued kind, the dispatcher reloads the current status and reconciles stale intent so an old fetched batch cannot knowingly send an obsolete confirmation. A transport already in flight when cancellation commits cannot be recalled: the cancellation notice provides the later authoritative status. External provider acceptance followed by a failed MongoDB acknowledgement can also produce a retry. Delivery is **at least once**, not exactly once. Run one notification dispatcher process until a shared worker-claim protocol is added; the process-local guard is not cross-process email ownership.

Tests use injected mail transports, synthetic customers, and isolated MongoDB databases. They never send live Brevo/SMTP email or change actual shop settings.

## Verification and limitations

Run the complete regression commands from the repository root:

```sh
npm run lint
npm run build
npm test
npm test --prefix server
npm run test:browser
```

Backend coverage includes scoped/invalid/expired/revoked authorization, hashed credential storage, customer CSRF and Origin checks, past/terminal eligibility, expired pending holds, cancellation persistence and cleanup failure, concurrent decisions, notification retries, and queue reconciliation. Browser checks exercise the customer/staff confirmations, token scrubbing, preserved state, responsive layouts, keyboard operation, and accessibility. Exact results and browser coverage belong in the pull request; do not infer production delivery or every assistive-technology/browser combination from the automated suite.

For manual checks, use an isolated test database, synthetic appointments, explicit local/test origin, a generated test-only secret, and an injected/fake SMTP transport. Do not point tests at the normal shop database or a live customer mailbox.

1. Create a future request and inspect a captured test email. The link uses the configured origin and contains its bearer only in the fragment. After opening it, inspect the address, application storage, network requests, and browser back/refresh behavior: no bearer remains in the visible URL or persistent web storage, and private responses are not cached.
2. Open two different appointment links in separate tabs. Each must retain its own scope. Change the path/reference without the corresponding credential; reject access. Reject missing/wrong CSRF and foreign Origin. Verify that customer cookies cannot authorize staff endpoints.
3. Cancel pending and confirmed requests, including a future request whose hold expired. Test Keep appointment, optional empty customer reason, staff explanation validation/preview, repeated cancellation, lost-response refresh, declined/past appointments, revoked/expired links, customer logout, and staff logout/back navigation.
4. Compare availability before/after cancellation, including overlapping durations, a concurrent approval, and injected reservation-cleanup failure. Confirm that only the saved cancelled record releases occupancy and other appointments remain intact.
5. Inspect captured pending, confirmed, declined, customer-cancelled, and staff-cancelled emails; verify saved reasons, timezone, original time, one logical cancellation event, safe line breaks, disabled-delivery wording, retry behavior, and the documented already-in-flight race. Then perform a separate operator-approved test-delivery check in the intended staging environment before production rollout.
6. Check desktop, tablet, and narrow mobile widths, keyboard-only focus/confirmation behavior, screen-reader status/error announcements, and 200% zoom. Confirm readable navy/orange contrast, visible actions, sensible wrapping, no clipped dialog or horizontal overflow, and honest contact-shop fallback. Automated Chromium/axe checks supplement manual assistive-technology testing; they do not replace it.

Known limits: no rescheduling, customer accounts, verified-email recovery, automatic token backfill, old-key ring, global multi-instance exchange limiter, cross-process email worker claim, guaranteed email delivery, or exactly-once SMTP. Bearer links can be shared or compromised by a recipient; expiry/revocation reduce that exposure but do not prove who clicked. Confirm Edward's policy, contact details, origin, and delivery configuration before deployment. No merge, production settings change, live-email send, or deployment is performed by these development tests.
