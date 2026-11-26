# Production operations: owner checklist

These checks explain what must be verified before real customers use the website. Repository tests use synthetic data and injected transports. They do not inspect private Render/Atlas configuration, provision backups or monitoring, send live mail, or prove that a real database can be recovered.

**Current operational status: UNVERIFIED unless the owner records the specific check below.** The owner has reported successful protected-staging email receipts, decisions and cancellations. That is useful evidence for that tested setup; ordinary production configuration and ongoing operation still need review. Keep protected staging enabled while preparing these checks.

## 1. Production email: real appointment notifications

This means the ordinary customer and mechanic emails sent after launch: receipts, confirmations, declines and cancellations. It is separate from the standalone connection test and the fixed-inbox synthetic workflow.

In the existing Render service's **Environment** controls, privately review these intended ordinary-email settings. Do not paste keys, passwords, management links, full connection strings or environment screenshots into chat or GitHub.

| Setting | Intended handling |
| --- | --- |
| `EMAIL_TRANSPORT` | `brevo_api` selects the Brevo HTTPS transactional API. |
| `BREVO_API_KEY` | Preserve the working private transactional key; verify the correct account and permission. |
| `MAIL_FROM` | `Ed's Auto Shop <contact@edsautoshop.com>` after confirming the authenticated sender. |
| `MECHANIC_NOTIFICATION_EMAIL` | `contact@edsautoshop.com`, or a separately reviewed monitored staff inbox. |
| `PUBLIC_WEBSITE_ORIGIN` | `https://edsautoshop.com`, with working HTTPS and the intended canonical domain. |
| `APPOINTMENT_MANAGEMENT_SECRET` | Preserve the existing stable private key. Routine deployments must not rotate it. |
| `STAGING_EMAIL_TEST_ENABLED` | `false` outside an intentional standalone probe. |
| `STAGING_APPOINTMENT_EMAIL_TEST_ENABLED` | `false` outside an intentional protected synthetic workflow. |

These settings can be prepared while `DEPLOYMENT_STAGE=staging`. **Ordinary appointment email remains disabled in protected staging even when both test flags are false and valid mail settings exist.** Do not remove the gateway or change stage merely to obtain a test email. Use the [scoped workflow procedure](appointment-email-workflow-test.md) for another owned-inbox test.

When a host terminal is available and already inherits the intended private environment, this command checks syntax without connecting to Atlas/Brevo or reading `.env` files:

```sh
npm run check:launch -- --json
```

Staging correctly remains a public-launch blocker. Exit zero still does not verify delivery or authorize launch. A laptop without Render's inherited settings cannot use this command to prove the hosted configuration; do not copy secrets into support output to compensate. If the hosting plan has no terminal, review the private settings in its dashboard and keep the live checks outstanding.

Owner verification record:

- [ ] Sender/domain authentication and monitored Reply-To inbox checked privately.
- [ ] All ordinary configuration values reviewed for the intended production revision and database.
- [ ] An operator-approved controlled test confirms both provider acceptance and actual inbox delivery, including a private management link, before broad public use.
- [ ] Brevo transactional events and bounce/failure handling can be checked by the owner. An application `sent` flag means provider acceptance, not guaranteed inbox delivery.
- [ ] One API/notification dispatcher is configured. Restarts and uncertain acknowledgements follow the [at-least-once notification procedure](customer-appointment-management.md#notification-semantics); no bulk replay of old requests.

Use a separate reviewed production database and reconciliation plan at the final launch step. Do not promote the old staging queue by changing a stage flag. Record dates/results privately without customer details or bearer links.

## 2. Backups: protected copies of the whole database

A backup is a recoverable copy of appointments **and** scheduling coordination data. Atlas and Compass being connected does not establish that any backup exists. An application image, GitHub repository, or frontend build is not a customer database backup.

In **Atlas → the intended cluster → Backup**, inspect the actual available controls. Availability depends on the current cluster/plan; do not assume the Free tier provides scheduled backups. Check the provider's current backup frequency, retention, encryption, permissions, failure alerts and restore destinations. If supported backups are not enabled, record that gap rather than marking this item complete.

If managed backups are unavailable, the [backup and restore runbook](backup-and-restore.md) documents an alternative encrypted full-database `mongodump` procedure. It requires an owner-operated Linux/WSL recovery environment with compatible MongoDB Database Tools and `age`; the shown Bash commands are not normal PowerShell commands. It is not an installed automatic backup job. Use a narrowly scoped read/backup account, protected configuration files and separately protected decryption keys, and keep completed encrypted copies in reviewed off-site storage. Do not add private files or archives to Git or Docker.

The standalone-compatible application needs a consistent snapshot: use a provider-documented consistent backup, or quiesce **all** writers and drain admitted API/email work before the manual full-database dump. Copying only `appointments` while the reservation ledger changes can break availability and approval consistency.

- [ ] Actual backup method enabled and a completed usable backup observed.
- [ ] Backup frequency, acceptable amount of lost recent work, archive retention and responsible person recorded.
- [ ] Encryption, off-site storage, least-privilege access and recovery-key access tested.
- [ ] Failed or missing backups produce an alert that reaches the responsible person.

## 3. Recovery: prove a backup can be restored

Recovery means restoring a reviewed backup into a **new isolated database** and checking that the application data works. A successful download or an archive file alone does not prove recovery.

Follow the guarded commands in [the restore drill](backup-and-restore.md#restore-drill-into-a-fresh-database-only), using a restricted account that can write only to the newly selected recovery database. Keep the live database untouched and all outgoing email disabled. The runbook checks whole-database consistency, records/statuses, indexes, reservations, services, held times and private notification history before recovered data is exposed.

- [ ] A complete backup restored successfully to a verified fresh recovery namespace.
- [ ] Appointment and scheduling data came from the same snapshot; representative synthetic availability/review/cancellation checks passed with mail off.
- [ ] Recovery time and the backup's age recorded so Edward knows how long recovery may take and what later changes require reconciliation.
- [ ] Restored queue intents, revoked customer access and automatic-booking settings reviewed before any real recovery switchover. Follow the runbook's management-key rotation requirement before exposing recovered data; routine redeployments still preserve the key.

## 4. Monitoring: notice failures and reach a person

Monitoring means alerts when the site/API is unavailable, the database cannot connect, a deployment/restart fails, or appointment email stops progressing. A dashboard that nobody checks is not an alerting process.

The minimal readiness endpoint is:

```text
https://edsautoshop.com/api/health
```

It intentionally contains no customer details. HTTP 200 with `database: connected` is a point-in-time readiness check; HTTP 503 indicates the service/database is not ready. `/api/health/live` checks process liveness. Neither endpoint verifies email delivery or backups.

An owner can inspect readiness in a browser or PowerShell without supplying credentials:

```powershell
Invoke-RestMethod 'https://edsautoshop.com/api/health'
```

- [ ] Render's health-check path is `/api/health`; restart/deployment alerts and their recipient are reviewed in the actual service dashboard.
- [ ] An external HTTPS uptime check and a separate working alert channel are configured; a test alert reached the responsible person. Review the chosen provider/plan rather than assuming alerts exist.
- [ ] The owner can inspect private Render startup/failure logs and Brevo transactional delivery events without publishing customer data, keys, cookies or links.
- [ ] Old pending notification intents, persisted retry deadlines and terminal `failed` messages have a private review process. The current app has no complete retry-status dashboard; do not assume database readiness means the queue is healthy.
- [ ] The expected backup alert, site alert and email-delivery failure response are documented with a responsible person and contact route.

Render Free may idle, pausing the process and scheduled email retries. Review the actual service plan's behavior and acceptable delays; monitoring does not guarantee an always-running worker. No paid plan or external service is purchased or configured by this checklist.

## Finish the launch review

Keep these items outstanding until the owner records real evidence. Recheck the approved business/privacy/cancellation profile, adopt the [manual retention and request procedure](privacy-requests-and-retention.md), verify individual mobile location/travel review and backup retention, then perform the [controlled launch verification](production-launch.md#controlled-verification-before-launch). There is no automatic deployment, data deletion, restore, public launch or email replay in this document.
