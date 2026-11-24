# Render staging preparation

This is an operator runbook for the restricted staging preview and subsequent review. The owner has deployed the preview; this document does not authorize another deployment, a purchase, public booking launch, or real notification delivery. Review and approve any additional deployment or cost separately from public launch.

The production-readiness work in [PR #15](https://github.com/JeffkM01/Mechanic-Shop-Website/pull/15) and staging preparation in [PR #16](https://github.com/JeffkM01/Mechanic-Shop-Website/pull/16) have been merged. Start subsequent changes from the latest reviewed `main`; retain the reviewed revision for rollback. This document does not authorize merging or deploying new work.

## Owner-reported state on November 24, 2026

The owner reports that the manually configured **Free** Render service at `https://mechanic-shop-website.onrender.com` works, `/api/health` reports `connected`, and the deployed booking settings and synthetic appointment/staff workflow have been checked. The owner also reports registering `edsautoshop.com` through Porkbun and successfully sending and receiving mail with the Zoho mailbox `contact@edsautoshop.com`. These are owner-reported milestones, not independent inspection of the host, DNS, Atlas permissions, or mailbox. Custom-domain website routing/TLS, Brevo delivery, hosted backup recovery, and alerts remain unverified.

## Current preview and intended production shape

The existing restricted Free preview serves React and Express from the same Render HTTPS origin, with a separate MongoDB Atlas database. Keep outgoing email disabled. There is no need to create another service, purchase a domain again, or apply the paid Blueprint merely to continue this preview. An always-running paid service remains the proposed production shape, subject to a separately reviewed quote and SMTP compatibility. Confirm the current plan's limitations before real notification operation: this application uses SMTP, and Free-service idle behavior prevents relying on a continuously running retry dispatcher. Current SMTP port restrictions were not independently verified here; check the selected service and [Render's Free-service documentation](https://render.com/docs/free). An HTTPS email API being reachable would not establish compatibility with this SMTP integration.

The purchased domain and Zoho mailbox can be connected without buying Google Workspace. The assigned Render hostname remains sufficient for protected staging while custom-domain setup is reviewed. Brevo remains the intended automated notification provider; Zoho hosts business correspondence. Neither mailbox setup nor domain ownership enables application email.

The root [Dockerfile](../Dockerfile) already builds the frontend and starts the Node API. Do not choose a `server` root directory: the image needs the root package files, frontend, and `shared` directory. There is no separate Vercel site, Node worker service, local MongoDB dependency, or persistent application disk in this proposal. The API itself runs the email dispatcher when email is enabled in an approved non-preview environment.

See [provider research](render-provider-reference.md) for the dated source review and the prices, provider restrictions, and account-specific facts that still require confirmation in the actual provider dashboard. Account ownership and private configuration stay with the owner.

## Account and database preparation

MongoDB Compass is a database client, not a hosting service. It can connect to Atlas once Atlas is configured. Installing Compass does not create an Atlas account or make the laptop's database available to Render. Do not reuse the damaged Windows D: drive, its database files, or a normal shop database.

1. Sign in to MongoDB Atlas in the owner's account, or create an account if only Compass is installed. Enable account MFA and retain recovery methods privately. Use an isolated staging project/cluster if the chosen plan permits it. Check the proposed region and cost before selecting any paid feature.
2. Reserve an unused database name such as `eds_staging_preview`. It must start with `eds_staging_` and satisfy the staging runtime's validation. This name is an example, not evidence that a database exists or is empty.
3. Create a distinct application database user with `readWrite` on **only that database**. Do not grant `atlasAdmin`, `readWriteAnyDatabase`, or access to the normal shop database. The application needs to create its collections and indexes. Confirm that the selected user's roles actually match the target database; a safe-looking database name cannot establish account privileges.
4. Use the provider's TLS-enabled `mongodb+srv` connection instructions. Put the intended database in the URI path and set `MONGODB_DATABASE` to the same name. Enter the URI only in Render's private environment settings; never paste it in chat, a PR, a screenshot, or shell history. Keep credentials out of `VITE_` variables and the image build.
5. Review Render's actual outbound addresses for the selected service/region, then allow those addresses in Atlas Network Access. Do not use an unrestricted `0.0.0.0/0` rule as a shortcut. If owner access through Compass is needed, add the owner's current IP separately and remove temporary rules after use. Atlas inbound network rules do not configure Express proxy trust.
6. Verify through the provider that the staging namespace is new/empty before first startup. Seed no copied customer records. The app creates a compatible initial configuration in a fresh database; that seed is **not** the saved shop configuration approved by Edward.

Do not connect a local test suite to Atlas. Automated tests must continue to own guarded, disposable synthetic databases on their isolated test server.

## Reviewable Render settings

The legacy proposed Blueprint is [deploy/render-staging.yaml](../deploy/render-staging.yaml). Its paid `starter` plan is a review artifact, **not the owner's existing manually selected Free service**. It need not be imported to continue that service. Merely committing it does not deploy anything, but importing a Blueprint can create billable resources and begin a first deployment, even with subsequent automatic deployments disabled. Do not import/apply it before explicit deployment and billing approval.

| Setting | Proposed value or owner action |
| --- | --- |
| Repository / branch | Latest reviewed `main` revision, pinned to the approved commit before a deployment. PRs #15 and #16 are merged; review subsequent changes separately. |
| Runtime / build | Docker; repository root context; root `Dockerfile`; default container command. |
| Plan / region | Owner-selected Free instance for this restricted, no-email preview. Confirm the actual region/plan in the Dashboard. Any future paid production plan or additional service needs a separately reviewed quote. |
| Instance count | Exactly one. No autoscaling, PM2 cluster, duplicate worker, or second live deployment of the same database. |
| Auto deployment | Off. Initial creation still requires an explicitly approved deployment. |
| Public routing | Assigned Render HTTPS origin serves both the website and `/api`; review the custom-domain steps below before changing the canonical origin. No wildcard credentialed CORS. |
| Health check | `/api/health`, with no Basic credentials. It reports only minimal readiness, never customer data. |
| Shutdown | App grace deadline shorter than the provider's verified termination window. A nonzero timeout exit requires reconciliation before reopening. |
| Database | Only the clean `eds_staging_*` namespace, with the restricted account described above. No local database files or application disk. |
| Email | Disabled by staging runtime, even if SMTP values are accidentally supplied. Do not enter live SMTP credentials for this preview. |

### Private environment review

Set these using Render's private runtime environment controls. Avoid sharing full environment screenshots or command outputs.

| Variable | Staging value / handling |
| --- | --- |
| `NODE_ENV` | `production` so mechanic cookies use Secure behavior. |
| `HOST` / `PORT` | Bind to `0.0.0.0`; use Render's assigned `PORT`. |
| `SERVE_FRONTEND` | `true`. |
| `DEPLOYMENT_STAGE` | `staging`; protects the preview and disables outbound mail. |
| `STAGING_ACCESS_PASSWORD` | New cryptographically random password of at least 32 characters, stored privately. Gateway username is `staging`. Use a password manager and a different secret from the staff password. |
| `MONGODB_URI` | Atlas connection string naming only the reviewed staging database. |
| `MONGODB_DATABASE` | Exact same explicit `eds_staging_*` database name. Startup validates the selection before connecting; roles, cluster identity, TLS, and emptiness remain operator checks. |
| `MECHANIC_ADMIN_PASSWORD` | Unique strong staff password; private and different from all other credentials. |
| `PUBLIC_WEBSITE_ORIGIN` | Exact working HTTPS origin, no path/query/fragment. Use the assigned Render origin until the chosen custom domain's routing and TLS have been verified; review before issuing any management links. |
| `APPOINTMENT_MANAGEMENT_SECRET` | Stable cryptographically random 32–128-byte secret encoded as base64/base64url; generate privately once and retain in protected secret storage. Do not regenerate each deploy. |
| `TRUST_PROXY` | `false` until actual trusted proxy IPs/CIDRs and the real forwarding behavior are verified. Do not guess a hop count or use blanket trust. |
| SMTP / sender / staff inbox | Leave unset for this preview. Never configure real customer recipients as test data. |

The staging HTTP gateway challenges all page, asset, and API requests except exact read-only health paths. Use it over HTTPS and share access only with approved testers. Gateway access is separate from mechanic authentication: the dashboard still requires staff sign-in, session expiry, CSRF checks, and logout. Browser-managed Basic credentials can remain cached; use a private browser window for review and rotate the gateway password to withdraw shared preview access. No staging password belongs in React, localStorage, a URL, a public profile, or logs.

Health exceptions are for the platform, not public readiness approval. The staging gateway and a separate synthetic database reduce exposure; they do not make a placeholder site ready for real customers. Do not add search indexing, advertising, or production links to this preview.

The template enables `BOOKING_RATE_LIMIT_ENABLED=true`: five submission attempts per observed IP in a fixed 15-minute window. Invalid submissions count too; rejected attempts return HTTP 429 with `Retry-After`. The counters are bounded, process-local and reset on restart. With proxy trust disabled, different testers may share a gateway IP budget; this is safe for a small preview but is not verified production abuse protection. Review actual inbound proxy ranges and legitimate traffic before choosing production quotas. `BOOKING_RATE_LIMIT_MAX` and `BOOKING_RATE_LIMIT_WINDOW_MINUTES` provide explicit limits without changing saved scheduling settings.

Run `npm run check:staging` (or `npm run check:staging -- --json`) in a controlled environment with the intended runtime values supplied privately. It does not read `.env`, connect to MongoDB, send email or print configuration values. It checks staging isolation, runtime syntax, enabled booking throttling, staff/management secret format, and HTTPS origin syntax. It cannot verify cluster identity, emptiness, privileges, real TLS routing, provider billing, or an operator's approval. The separate `npm run check:launch` remains blocked for staging, even if an approved business-profile fixture is supplied.

### One process and deployment overlap

Setting the steady-state instance count to one does not prove that a platform's rolling update avoids overlap. The current dispatcher has no distributed lease and staff sessions are process-local. Two briefly overlapping old/new instances can duplicate delivery or produce inconsistent session behavior.

The protected staging preview has synthetic records and email forcibly disabled, so a default rolling replacement cannot create overlapping mail dispatchers. Its process-local mechanic sessions may still be lost or inconsistent during overlap; sign in again after an update. This limited preview behavior is not evidence that default rolling deployment is safe for the production email worker.

Before enabling actual delivery/public operation, establish and verify a stop-before-start procedure: block new ingress, stop the current process, wait for graceful shutdown and notification acknowledgement, verify the old process is no longer running, then start the replacement. Accept a maintenance outage. Do not rely on the default zero-downtime rolling replacement against a live shop database without a separately implemented shared worker-claim/session design. Verify the provider can perform the selected sequence before public launch; a document alone does not configure it.

## Review saved shop settings without replacing them

Use [the business/settings review](staging-business-review.md). The user's approved database values differ from repository seed defaults. Do not dump/import real appointments or silently overwrite existing settings to make a preview match the seed.

For a new empty staging database, enter reviewed **synthetic** hours/settings through the protected dashboard. Label the test schedule as synthetic in the review record. Do not mark the actual business hours/capacity verified from an incomplete text snapshot. The staging runtime does not disable the user's approved automation; eligibility and status decisions continue to be enforced by the normal scheduler.

The no-email preview can test saved appointment decisions, conflicts, staff sessions, and persistence. It cannot prove Brevo delivery or emailed management links. A later controlled-mail test needs its own approved sender/reply inbox, owned recipient allowlist, recipient protection, and approval to send. Do not remove staging mode simply to turn email on: that also removes its access/database safeguards. Reconcile/suppress obsolete synthetic queue entries through a reviewed record-specific process before enabling any dispatcher; saved pending notifications may otherwise send later.

## Connect the purchased domain without disturbing Zoho

The owner reports that `edsautoshop.com` ownership and the Zoho mailbox work. Website routing is a separate check. The following are owner actions to review; no provider settings are changed by this runbook.

1. Open the **existing** Render service, then **Settings → Custom Domains**, and add `edsautoshop.com`. Review whether Render also requests a `www` alias and choose one canonical HTTPS hostname.
2. Copy the actual DNS record type, name, and target shown by Render. Use its current instructions rather than a remembered Render IP address. A CNAME target is a hostname, not an `https://` URL or a path.
3. In Porkbun **Domain Management → edsautoshop.com → DNS**, change only the website A/ALIAS/CNAME records needed for those instructions. Resolve conflicting website records individually. Preserve Zoho's MX records, domain-verification TXT, SPF, DKIM, and other unrelated records. Keep the existing DNS provider/nameservers unless a separately reviewed migration is necessary.
4. Return to Render to verify the domain and wait for its HTTPS certificate to become valid. Check the intended apex/`www` behavior, homepage, `/mechanic`, direct page links, and `/api/health` from an external device. Verify the staging password still protects the website and private APIs. Test the Zoho mailbox again after DNS changes.
5. Only after the canonical custom domain actually works over HTTPS, review setting `PUBLIC_WEBSITE_ORIGIN=https://edsautoshop.com` if the apex was chosen. Use the actual chosen origin if different. Keep `DEPLOYMENT_STAGE=staging` and the stable `APPOINTMENT_MANAGEMENT_SECRET`; changing the public hostname does not authorize real management links or public bookings.

The optional schema-version-1 field `contact.emailConfirmed` allows the approved `contact@edsautoshop.com` inbox to appear independently of unknown phone/location details. It does not set aggregate `contact.confirmed`, approve privacy wording, or clear the public-launch contact blocker. The phone, exact service area, travel arrangements, and remaining policies still need review.

## Prepare Brevo authentication while keeping preview email off

Zoho receives and sends ordinary business correspondence. Brevo will deliver application notifications when a later guarded phase is approved. The successful Zoho mailbox test does not establish that Brevo is authenticated or that Render can reach its SMTP service.

1. In Brevo, add/authenticate `edsautoshop.com` and verify the proposed sender `contact@edsautoshop.com` using the owner's account. Copy only the records Brevo actually requests. Preserve Zoho MX and DKIM records. Keep one SPF TXT record per hostname and one DMARC record at its applicable name; combine compatible sender requirements where necessary rather than creating competing records. Do not invent a Brevo SPF include or blindly replace an existing Zoho policy.
2. Review these **proposed later configuration values**, which are public sender/inbox addresses rather than secrets:

   ```text
   MAIL_FROM=Ed's Auto Shop <contact@edsautoshop.com>
   MECHANIC_NOTIFICATION_EMAIL=contact@edsautoshop.com
   ```

   Existing customer templates use `MECHANIC_NOTIFICATION_EMAIL` as Reply-To; staff request/cancellation notices reply to the customer's address. There is no separate `MAIL_REPLY_TO` variable. Sender authentication, staff notice delivery, and customer replies each need a controlled test.
3. Obtain Brevo's SMTP host, port, login, and SMTP key privately when that test is approved. A Brevo SMTP key is not the Zoho mailbox password. Keep these credentials out of source control, chat, images, and frontend variables. Confirm the selected Render service can reach the required SMTP host/port and can run retries reliably; current Free restrictions remain an operator verification requirement. Do not assume that buying a paid plan alone proves connectivity.
4. Keep SMTP unset for the current preview. The staging runtime intentionally suppresses delivery and management-link issuance even if SMTP credentials are supplied. A later controlled-mail phase requires separately reviewed recipient protection, an owned test-recipient allowlist, handling of accumulated synthetic notifications, and explicit send approval. There is no supported instruction to enable email merely by changing `DEPLOYMENT_STAGE`; that would also remove the preview safeguards.

Record Brevo for automated notifications **and Zoho Mail for business correspondence** in the privacy-provider draft. Keep privacy approval false until retention, request handling, provider agreements, and the remaining contact/policy details have been approved.

## Backups, monitoring, recovery, and rollback

Atlas free/shared tiers and Render service disks must not be assumed to provide database backups. Verify the selected plan's actual backup and recovery features. Follow [backup-and-restore.md](backup-and-restore.md) for a protected full-database backup and a restore into a **fresh isolated** target. Quiesce every writer for a consistent standalone-compatible dump unless a documented provider snapshot procedure supplies the required consistency. Never restore over the normal shop database as a drill.

Record backup frequency, allowed loss window, retention, encryption/key ownership, access, storage location, and restore-test date. Backups include private customer and authorization metadata. Keep encrypted artifacts and keys out of source control, container layers, public assets, and logs; keep the recovery identity separate from the archive. Test recovery before accepting real bookings.

Configure and test `/api/health` monitoring and owner alerts. Add a separate protected check for old pending/failed notification intents; health success does not prove email delivery. Verify logs exclude bodies, cookies, passwords, connection strings, management tokens, and customer locations. An alert configuration is incomplete until a test alert reaches the owner.

Retain the reviewed app commit/image and configuration record for rollback. Stop the current process before starting the compatible earlier image; do not run both dispatchers. Confirm the old code understands the stored service catalog, scheduling schema, retry metadata, and `failed` notification state. A code rollback does not roll back MongoDB, recall mail, or revive revoked links. Restored databases require reconciliation and management-key rotation before exposure, as described in the recovery runbook.

## When the image builds but the application exits

A successful Vite/Docker build does not verify runtime credentials or Atlas
network access. The application connects to MongoDB and initializes indexes and
scheduling state before opening its HTTP listener. A failed startup still exits
with status 1, but now logs one fixed diagnostic category instead of exposing a
driver error or printing environment values.

| Log category | Operator check |
| --- | --- |
| `STAGING_ACCESS_PASSWORD` | Set a separate random 32–256-character preview password. Enter only the generated value in the Value field, without whitespace or placeholder text. |
| `STAGING_DATABASE_NAME` | `MONGODB_DATABASE` must name the intended isolated `eds_staging_*` database. |
| `STAGING_DATABASE_URI` | Use the exact key `MONGODB_URI`, not `MONGODB_URL`. Its database path must match `MONGODB_DATABASE`; encode password characters and keep verified TLS enabled. |
| `MECHANIC_ADMIN_PASSWORD` | Set the separate generated staff password. It is not the Atlas user's password. |
| `DATABASE_AUTHENTICATION` | Review the intended database user, password and URI encoding privately. |
| `DATABASE_PERMISSION` | Verify `readWrite` on only the intended staging database; do not resolve this by granting administrator access. |
| `DATABASE_DNS` / `DATABASE_TLS` | Check the real cluster hostname, cluster status, DNS, certificate trust and clock. Keep certificate/hostname verification enabled. |
| `DATABASE_UNREACHABLE` | Check cluster availability, DNS/TLS and Atlas Network Access against the service's actual Render outbound addresses. This category does not prove which network rule failed; do not add `0.0.0.0/0` as a shortcut. |
| Other configuration, index, settings or HTTP phases | Follow the named phase's fixed advice. Preserve existing records/indexes/settings; investigate compatibility before changing data. |

Copy only the fixed category/advice when requesting help. Never publish raw
connection strings, passwords, SMTP keys, management secrets, request bodies or
arbitrary driver errors. An unknown error retains a generic phase diagnostic.
The reporting change does not relax validation, enable email, change saved
booking rules or automatically retry a deployment. Keep Auto-Deploy off and
manually select the reviewed revision when a staging retry is authorized.

CI also runs the packaged application with deliberately invalid synthetic
configuration and with networking disabled, verifying nonzero exits and redacted
diagnostics. These checks do not contact Atlas or send email.

## Approval and hosted verification

Repository checks validate synthetic code paths. They do not create accounts, configure provider ACLs, prove HTTPS forwarding, verify the actual schedule, purchase a plan, or perform a remote restore.

Before requesting approval, provide the exact commit, proposed plan/region/cost, disabled auto-deploy setting, one-process replacement method, restricted database identity, gateway configuration, no-email state, and remaining business blockers. Request approval specifically for a **restricted staging deployment**, not a public launch.

After explicit staging approval, verify from an external device:

1. HTTPS, unauthenticated gateway rejection, private page/API headers, authenticated deep links, missing API/asset 404s, and public minimal readiness.
2. Actual reverse-proxy addresses/forwarded IP handling, Secure cookies, CSRF, login throttle, booking-abuse rejection, staff logout/back navigation, and inactivity expiry.
3. Synthetic manual and eligible automatic decisions, overlapping/concurrent rejection, persistence across a controlled restart, pending expiry, cancellation, and preservation of unrelated reservations. Check the saved configuration, not just the displayed labels.
4. Alerts and a full isolated backup/restore drill. Keep SMTP disabled and record that actual delivery/emailed management links are unverified.

Only after separate approval and guarded recipient setup should a controlled Brevo send test take place. Actual public booking requires Edward's completed contact, privacy, service-area/work-location, travel, scheduling, and policy review. Placeholders remain a launch blocker.

## Next owner action

Review the existing service's **Custom Domains** screen and connect `edsautoshop.com` using the DNS values Render supplies, preserving Zoho records as described above. Report whether domain verification and HTTPS succeed; share only public DNS names/values when help is needed. Keep staging protection and SMTP-off behavior in place. Brevo authentication, guarded delivery tests, phone/service-area/travel decisions, privacy approval, backup recovery, and monitoring remain separate next steps; do not recreate Atlas or repurchase a domain for this review.
