# Controlled appointment email workflow test

The owner reports that the standalone **[TEST ONLY] email connection test** reached `contact@edsautoshop.com`. That proves the tested Render-to-Brevo connection and mailbox path at that time. The next step is a separate, reviewed test of actual appointment receipts, decisions, cancellations, and private management links.

This runbook does not authorize a deployment, purchase, public launch, real customer booking, or automatic queue replay. Development and CI use injected transports and guarded synthetic databases; they do not send these live messages. The owner applies the reviewed staging revision and performs the live steps deliberately.

## Scope and safeguards

There are three distinct protected-staging modes:

| Mode | What can send |
| --- | --- |
| Default | Appointment email and management grants remain disabled. |
| Standalone connection test | Only the fixed synthetic probe, when explicitly requested by authenticated staff. It never reads the appointment queue. |
| Scoped appointment workflow test | Only notifications for new synthetic appointments created in the active reviewed run, addressed to the fixed owner inbox. The standalone probe must be disabled. |

The workflow mode always uses Brevo's HTTPS API. From, To, and Reply-To are locked to `contact@edsautoshop.com`, with the sender name `Ed's Auto Shop`. Every message subject starts with **[TEST ONLY]**, and its body identifies a private synthetic appointment test. Browser input cannot select another recipient or forge the run marker. The server rejects a different customer email before making a booking reservation or writing an appointment.

The server assigns an immutable private `notificationTestRunId` only when a request is newly created in this mode. Older untagged requests, different run IDs, and mismatched recipients are excluded from the queue and checked again before each send. They are never retagged or backfilled when confirmed or cancelled. Existing histories, holds, confirmed reservations, and retry metadata remain intact. Staff can still review old requests, but their out-of-scope actions do not send workflow-test email.

All tagged test records are also excluded from ordinary unscoped notification delivery and customer-management authorization. Turning this feature off or later using ordinary production configuration cannot replay tagged test messages. Keep staging and production databases separate anyway; do not copy synthetic test records into production.

These exclusions require this revision or newer compatible code. Before rolling back to code that predates the run marker, keep protected staging and all appointment-mail processing disabled; do not run that older dispatcher against the test database with mail enabled. Older code cannot recognize tagged test records. Review the database and notification configuration before any rollback or later public launch.

## Prepare the reviewed revision

1. Review the feature PR, automated results, and these limitations. After acceptance, merge and manually deploy the reviewed revision to the existing restricted staging service. Keep automatic deployment off and keep one API/dispatcher process.
2. Keep `DEPLOYMENT_STAGE=staging`, the existing staging gateway, and the isolated `eds_staging_*` database. Do not remove the gateway or switch to production to test mail. Preserve mechanic authentication, CSRF, and session protection.
3. Verify that the intended fixed owner inbox remains controlled and that the existing private Brevo key authorizes transactional sends. Do not share the key, mailbox passwords, MongoDB URI, gateway password, or complete environment screenshots.
4. Review saved staging booking settings without changing approved hours, services, capacity, or automation just for this test. Test requests consume staging availability and automatic-confirmation limits. Use new valid future slots that meet advance-notice and booking rules; do not clear old reservations to manufacture availability.

## Private Render runtime settings

Use the existing service's private environment controls after reviewing the deployment revision:

| Setting | Value / handling |
| --- | --- |
| `DEPLOYMENT_STAGE` | Keep `staging`. |
| `STAGING_EMAIL_TEST_ENABLED` | Set `false`; the standalone probe and workflow mode cannot be enabled together. |
| `STAGING_APPOINTMENT_EMAIL_TEST_ENABLED` | Set `true` only for this controlled workflow run. Unset or `false` keeps the workflow disabled; malformed values and unprotected activation fail closed. |
| `STAGING_APPOINTMENT_EMAIL_TEST_RUN_ID` | A fresh UUID v4 for this reviewed run. This is a run selector, not an authentication secret. Keep it out of public status responses and ordinary support uploads. |
| `BREVO_API_KEY` | Preserve the working private transactional key in the host secret store. |
| `PUBLIC_WEBSITE_ORIGIN` | `https://edsautoshop.com`, after confirming the already configured custom domain/TLS still works. Management links use this origin. |
| `APPOINTMENT_MANAGEMENT_SECRET` | Keep the existing stable private key. Do not rotate it for a test, restart, or ordinary deployment; rotation invalidates existing management credentials. |

No SMTP credentials or additional `EMAIL_TRANSPORT`, `MAIL_FROM`, or staff-recipient overrides are needed for this mode: the server builds a locked API configuration. Preserve working Zoho MX/SPF/DKIM, Brevo authentication, and Render domain records.

Generate the run ID locally with a UUID v4 generator, for example PowerShell:

```powershell
[guid]::NewGuid().ToString()
```

Use a fresh UUID for each separate run. Keep the same ID only when intentionally resuming the same reviewed run after a restart: its retained pending messages may resume delivery. A new ID excludes every previous run, including pending retries. Enabling a fresh run does not send a message by itself; creating and acting on its test appointments drives the normal durable notification workflow.

`npm run check:staging` is an offline check of inherited operator settings. It does not load private `.env` files, connect to Atlas, contact Brevo, send mail, or approve deployment. Its text/JSON distinguishes scoped workflow mode from the standalone probe and default mail-off mode without printing run IDs or secrets. The public-launch check rejects an enabled or malformed workflow flag.

## Exercise the lifecycle

Open the protected HTTPS site and verify the appointment form shows the private workflow-test notice and fixed, read-only `contact@edsautoshop.com` email. Enter only fictional names, phone numbers, vehicles, and notes. Do not use real customer information. Sign into `/mechanic` with the separate mechanic password; the dashboard should identify the active test and explain that older/out-of-scope requests are excluded.

Create separate requests for the branches below. Use an offered, active manual-approval service such as Brake Repairs for pending-flow cases. Wait for the initial messages to arrive before changing that request's status, so the checks observe each lifecycle stage. A later decline/cancellation can correctly suppress a stale pending receipt that has not yet sent.

| Action | Expected additional messages to the same owned inbox |
| --- | --- |
| Submit a new manual-approval request | One customer pending receipt and one mechanic request notice. Verify the saved request remains pending. |
| Confirm that request after its receipts arrive | One customer confirmation; verify confirmed status persists after refresh. |
| Decline a separate pending request | One customer decline with the exact saved customer-facing explanation. No fabricated replacement time. |
| Mechanic cancels a separate future request | One customer cancellation with the saved reason. Verify the cancelled record remains and only its reservation is released. |
| Customer cancels another future request using its emailed management link | One customer cancellation and one separate mechanic cancellation notice. Verify the recorded actor is customer, the page disables further cancellation, and any repeated API cancellation preserves the original metadata without queuing new notification intents. |
| Submit Wiper Blade Replacement while the mobile booking policy is active | One pending customer receipt and one mechanic notice. All new mobile requests require location/travel review, even when saved wiper automation is enabled. Confirm through the mobile review dialog, then expect one customer confirmation. |

New mobile requests always require mechanic review. Historical non-mobile requests retain their recorded rules. Do not enable automation or change service approval rules solely to manufacture an automatic case. Repairs and diagnostics always require mechanic approval. Confirm the saved status rather than assuming that an available time means automatic confirmation.

Check subject/body **TEST ONLY** labeling, actual inbox/spam arrival, sender, Reply-To, service, shop-local date/time, estimate wording, hold expiry, and saved decision/reason. API/provider acceptance and a `sent` notification flag mean the provider accepted a handoff; they do not prove inbox delivery. Review Brevo's delivery events privately if needed.

Customer management links contain private bearer fragments. Open a link only from the owned inbox; do not paste it, its token, or a screenshot containing it into chat, GitHub, logs, analytics, or support uploads. Verify the link opens the protected custom-domain site, exchanges the fragment without leaving it in the visible URL or persistent browser storage, and grants access only to that appointment. Test management sign-out and subsequent access denial. A prior run's or older untagged record's link cannot authorize access in the current workflow run.

Record the reviewed revision, test time, safe reference, expected action, provider acceptance, and actual inbox result privately. Do not repeatedly submit bookings after a lost response: a booking may already have been saved. Check the dashboard before retrying. The documented message counts describe distinct logical messages, not an exactly-once delivery guarantee.

## Failures, retries, and ending the test

The dispatcher preserves per-kind retry/backoff, bounded failure history, permanent recipient-failure handling, and acknowledgement semantics. Delivery is **at least once**: Brevo may accept a message before a database acknowledgement fails, which can cause a later duplicate. Use the [notification recovery procedure](customer-appointment-management.md#notification-semantics) for uncertain or terminal results; do not blindly rewrite notification flags or replay old requests.

When finished, set `STAGING_APPOINTMENT_EMAIL_TEST_ENABLED=false` through the reviewed runtime-change/restart procedure. Keep `STAGING_EMAIL_TEST_ENABLED=false` and protected staging enabled. The retained run tag and pending intents are not deleted. They remain excluded from ordinary delivery; deliberately resuming that same run later can make its eligible pending messages send again.

Disabling the mode, switching run IDs, cancelling, or stopping a worker cannot recall a message already handed to the transport. Graceful shutdown waits for accepted work and send acknowledgements within its deadline. Reconcile uncertain results after a timeout rather than assuming delivery stopped instantly.

## Schema and operational limits

`Appointment.notificationTestRunId` is an optional, immutable, private field with a partial run-ID/creation-time index. Existing records need no backfill, retagging, status migration, or deletion. Only safe active-mode/recipient and per-row eligibility indicators reach the website; neither the marker nor transport credentials belong in public appointment DTOs.

These are real saved synthetic appointments in the isolated staging database. Their reservations, durations, holds, status transitions, histories, and daily automation counts obey normal rules. Reconcile or cancel synthetic reservations through the normal protected workflow after testing; do not delete scheduling coordination documents independently.

Brevo HTTPS avoids depending on SMTP ports, but Render Free can idle and pause notification retries. This mode does not establish continuously running delivery, production uptime, monitoring, backups, or recovery. Public phone/contact completion, a confirmed mobile service area and appointment-location process, travel-time allowance, privacy/retention/request-policy approval, cancellation wording, provider review, and operational readiness remain separate launch checks in the [production runbook](production-launch.md). Successful staging mail does not approve public launch.
