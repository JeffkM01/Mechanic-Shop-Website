# Render staging preparation

This is a deployment proposal and operator runbook. No Render service, Atlas database, purchase, public booking launch, or email delivery is authorized by this document. Obtain explicit approval for the reviewed staging revision and its cost before creating/deploying the Render service. Keep the public launch separate from that approval.

The staging branch builds on the unmerged production-readiness work in [PR #15](https://github.com/JeffkM01/Mechanic-Shop-Website/pull/15). Merge/review order and the final main revision need checking before deployment; this document does not authorize merging either PR.

## Proposed shape

Use one paid, always-running Render Docker Web Service serving React and Express from the same HTTPS origin, plus a separate MongoDB Atlas database. Brevo remains the intended email provider, but outgoing email is disabled for this staging preview. A custom domain and Google Workspace are unnecessary for this review; Render's assigned HTTPS hostname is sufficient.

The root [Dockerfile](../Dockerfile) already builds the frontend and starts the Node API. Do not choose a `server` root directory: the image needs the root package files, frontend, and `shared` directory. There is no separate Vercel site, Node worker service, local MongoDB dependency, or persistent application disk in this proposal. The API itself runs the email dispatcher when email is enabled in an approved non-preview environment.

See [provider research](render-provider-reference.md) for current verified costs, provider restrictions, and items that still require confirmation in the actual provider dashboard. Account ownership and private configuration stay with the owner.

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

The proposed Blueprint is [deploy/render-staging.yaml](../deploy/render-staging.yaml). It is a review artifact; merely committing it does not deploy anything. Importing a Blueprint can create billable resources and begin a first deployment, even with subsequent automatic deployments disabled. Do not import/apply it before explicit deployment and billing approval.

| Setting | Proposed value or owner action |
| --- | --- |
| Repository / branch | Reviewed staging feature branch, pinned to the approved commit before deployment. Recheck PR #15 dependency first. |
| Runtime / build | Docker; repository root context; root `Dockerfile`; default container command. |
| Plan / region | One always-running paid instance; price and selected region reviewed before creation. A free account does not mean this service is free. |
| Instance count | Exactly one. No autoscaling, PM2 cluster, duplicate worker, or second live deployment of the same database. |
| Auto deployment | Off. Initial creation still requires an explicitly approved deployment. |
| Public routing | Assigned Render HTTPS origin serves both the website and `/api`; no wildcard credentialed CORS. |
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
| `PUBLIC_WEBSITE_ORIGIN` | Exact assigned HTTPS origin, no path/query/fragment. Obtain it from the service, then review before issuing any management links. |
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

Check whether an **Atlas account/deployment** exists in addition to Compass. If not, create the Atlas account in the owner's name and review the free-tier deployment screen. Do not paste the connection string here or create a paid Render service yet. Report only whether Atlas is available and the proposed region; the next step can then be reviewed without exposing credentials.
