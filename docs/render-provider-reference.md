# Provider verification for Render staging

Reviewed on November 17, 2026. No accounts, services, subscriptions, backups, or
email deliveries were created or enabled during this review.

## Recommended shape

Use one paid, always-running Render Docker Web Service serving the React build
and Express `/api` routes from the same HTTPS origin. Keep one process and one
email dispatcher, with a separate MongoDB Atlas staging database and Brevo for
transactional email. Do not store MongoDB files or backups on the web service's
ephemeral filesystem. Compass is a desktop database client, not a hosted database;
it can connect to the separate Atlas deployment once its access is configured.

The free Render account/workspace and the selected service's compute plan are
different things. Account creation does not establish an always-running compute
plan or approve any billing. Select and approve the compute plan in the Dashboard
before creating the service. Do not enable autoscaling or independently deploy a
second email worker.

## What was actually verified

Direct requests to Render and MongoDB's documentation websites were rejected by
this development environment's network policy (`CONNECT 403`). The official
public GitHub source repositories below were accessible and read. A GitHub source
reference does not prove a feature is enabled in the owner's particular account.

| Item | Verified information and required account check |
| --- | --- |
| Render plan terminology | Render's official reference distinguishes workspace plans from compute plans. It says legacy IDs such as `starter` remain accepted, while newer compute IDs exist. It explicitly directs readers to the current compute catalog for availability and prices. The current payable amount was **not verified** here; review the Dashboard quote rather than treating a remembered price as current. |
| Manual deployments | Official Render Blueprint reference documents `autoDeployTrigger: off`, `numInstances`, `healthCheckPath`, Docker configuration, and `maxShutdownDelaySeconds` (1–300 seconds; documented default 30). Keep automatic deployment and previews off. Blueprint creation can itself create/deploy a service, so reviewing or committing YAML does not authorize applying it. |
| Disk persistence | Official Render disk reference says the default service filesystem is ephemeral. Disk snapshots are not application-consistent database backups and must not be used to recover a custom database. This design uses Atlas, not a MongoDB process on a Render disk. |
| Atlas Free limits | Official MongoDB source documents 0.5 GB storage, 500 connections, 100 operations/second, 10 GB inbound and 10 GB outbound in a rolling seven-day period, and automatic pause after 30 days with no connections. Free clusters lack private endpoints, database auditing, and customer-managed encryption keys. Confirm the offered region and limits in the account before choosing it. |
| Atlas Free backups | Current official source describes an **optional paid private preview**, with gradual availability: daily snapshots retaining the latest four, at $0.10/day capped at $3.00/month per cluster. A payment method is required. Do not assume this preview is available or enabled. Cancelling immediately deletes existing snapshots; deleting the cluster removes access and deletes them within 24 hours. This is not a point-in-time recovery guarantee. |
| Atlas/Render connection | Official MongoDB integration instructions specify a nearby AWS region and adding the Render service's actual outbound IP addresses to Atlas network access. Use the addresses shown for the real service, not a guessed range or `0.0.0.0/0`. Give the application database user access only to its staging database. |

Source revisions read:

- Render references at commit [`b985a63`](https://github.com/render-oss/skills/tree/b985a6399ad64b2d7093cb5ee7bb29487ae05fee):
  [compute plans](https://github.com/render-oss/skills/blob/b985a6399ad64b2d7093cb5ee7bb29487ae05fee/skills/render-blueprints/references/compute-plans.md),
  [Blueprint fields](https://github.com/render-oss/skills/blob/b985a6399ad64b2d7093cb5ee7bb29487ae05fee/skills/render-blueprints/references/field-reference.md),
  [persistent disks](https://github.com/render-oss/skills/blob/b985a6399ad64b2d7093cb5ee7bb29487ae05fee/skills/render-disks/references/persistent-disks.md).
- MongoDB documentation at commit [`396d145`](https://github.com/mongodb/docs/tree/396d1459304810b7c95948cf9de3fb0291fa0899):
  [Free limits](https://github.com/mongodb/docs/blob/396d1459304810b7c95948cf9de3fb0291fa0899/content/atlas/source/reference/free-shared-limitations.txt),
  [Free backup preview](https://github.com/mongodb/docs/blob/396d1459304810b7c95948cf9de3fb0291fa0899/content/atlas/source/backup/cloud-backup/free-cluster-backup.txt),
  [Render integration](https://github.com/mongodb/docs/blob/396d1459304810b7c95948cf9de3fb0291fa0899/content/atlas/source/reference/partner-integrations/render.txt).

## Required price, terms, and network checks before approval

The following items could **not** be verified from current canonical pages in
this environment. They remain review requirements, not implied approvals:

| Official page | Check in the owner's browser / Dashboard |
| --- | --- |
| [Render pricing](https://render.com/pricing) and [compute plans](https://render.com/docs/compute-plans) | Current smallest appropriate paid Docker compute plan, region, RAM, monthly compute cost, workspace charges, build minutes, included bandwidth, and overage charges. Include tax and any separate staging/production services in the quote. |
| [Render free services](https://render.com/docs/free) | Current idle spin-down/cold-start behavior, free-hour allowance, limitations and outbound SMTP restrictions. Do not rely on a free service for an always-running email retry worker. |
| [Render free-service limitations](https://render.com/docs/free) and the selected service's networking/support information | Whether the selected paid service can reach Brevo's configured SMTP host/port. This application currently uses SMTP; a claim that HTTPS email APIs work does not verify SMTP support. Do not purchase a plan solely on an unverified assumption that SMTP works. |
| [Render terms](https://render.com/terms) | Current terms applicable to commercial use, acceptable use, account ownership, billing, suspension, and service-level commitments. No commercial-use or SLA guarantee is asserted by this runbook. |
| [Render outbound IPs](https://render.com/docs/outbound-ip-addresses) and [web services](https://render.com/docs/web-services) | Exact service outbound ranges for Atlas and actual inbound proxy/client-IP behavior. Outbound ranges are **not** evidence of trusted inbound proxy ranges. Keep `TRUST_PROXY=false` until the actual ingress is verified; a guessed hop count or broad trust is not acceptable. |
| [Atlas pricing](https://www.mongodb.com/pricing) and the cluster Backup page | Current cluster quote and whether the optional Free backup preview is offered. Do not call provider snapshots enabled without checking the account. |
| [Brevo pricing](https://www.brevo.com/pricing/) and [SMTP documentation](https://developers.brevo.com/docs/smtp-integration) | Current quota/overage limits, verified sender/reply address, SMTP credentials entered privately, and eligibility of the chosen account. Keep SMTP disabled during initial staging; real test sends require separate approval. |

## Expected recurring-cost worksheet

There is no verified all-in monthly total yet. Before approving deployment,
record the owner-visible quote for:

1. One paid always-running Render compute instance (plus any workspace and
   usage charges shown). Staging and production running simultaneously are
   separate billable services.
2. Atlas cluster tier: a Free cluster can suit isolated synthetic staging within
   its limits; a production database choice must include capacity and recovery
   requirements. The optional Free backup preview, **if offered and approved**,
   adds up to $3/month per cluster under the source pricing above.
3. Encrypted independent backup storage/automation and monitoring. Do not assume
   these exist just because the database is hosted.
4. Brevo plan within its verified quota, plus any required paid features/overages.
5. Optional domain and business inbox. The assigned Render HTTPS hostname avoids
   requiring a domain purchase for staging; Google Workspace is not a staging
   dependency. A registrar's quote is separate from hosting and email.

Use the checklist in [the staging runbook](render-staging.md), then the existing
[backup and restore procedure](backup-and-restore.md). Take and restore an
isolated synthetic backup before claiming recovery is tested. Provider security
features do not replace correct application access control, private secrets,
least-privilege users, restricted networks, owner policy decisions, or recovery
testing.
