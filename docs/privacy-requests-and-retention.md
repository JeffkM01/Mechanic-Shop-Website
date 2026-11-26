# Privacy requests and manual retention review

## Approved policy

The owner approved review for deletion **two years after the scheduled appointment date**, or **90 days after that same date for declined/cancelled requests**. Outstanding work and records that must be retained are exceptions. These are review thresholds, not promises of deletion exactly on a particular day. The source profile records approval and its effective date in the shop's America/Chicago timezone.

This change updates public wording and operator instructions. It does not install a purge job, recurring reminder, backup expiration, dashboard deletion button, or database-cleanup script. No existing records or backups are deleted. The policy does not establish that backups, recovery, monitoring or ordinary production email are configured.

## Customer corrections and deletion requests

Customers email **contact@edsautoshop.com**. The owner handles requests manually:

1. Identify the requested correction/access/deletion without asking for passwords or the complete private management link.
2. Verify identity privately against contact information already on the relevant request. A reference ID alone is not proof of identity. A request to change its contact information requires particular care; do not send another customer's information to an unverified address.
3. Review outstanding work, active appointments and records that must be retained before deciding the appropriate correction or deletion. Do not promise unconditional erasure or an automatic database change.
4. Explain the outcome privately and record the review in a protected operational record. Keep customer details, credentials and bearer links out of GitHub, public logs and screenshots.

The website does not provide self-service record editing/deletion. Staff must use an appropriate authorized, reviewed process; these instructions do not grant access to a normal or production database.

## Periodic retention review

Assign a responsible person and an owner-operated review reminder. No reminder has been configured by the repository. Use the saved appointment date and shop timezone, not the date of a recent email or the date of cancellation, to determine the applicable threshold. A past confirmed status does not prove that all work or obligations are settled; verify the exception review first.

Keep review separate from deletion. Account for appointment history, mobile review/location/contact fields, customer access grants, queued notifications and the reservation ledger as one logical system. Do not independently delete `schedulingstates` or fragments of an active reservation, or blindly mark notifications sent/suppressed. The current dashboard shows a bounded recent list; it is not a complete retention inventory.

Before any eventual cleanup, an authorized operator must review the intended database, actual record eligibility, outstanding work/required records, notification intent, related scheduling state and consistency, recovery plan and a private audit of the decision. No bulk cleanup command is provided or executed here. An expired provisional hold releases availability under scheduling rules; it does not automatically delete or confirm the customer request.

## Backups and recovery

Backup availability, retention period, encrypted storage and expiry remain separate operator decisions in the [production operations checklist](production-operations-checklist.md) and [backup/recovery runbook](backup-and-restore.md). Do not promise that deleting a live record immediately erases existing backup copies. Review how approved corrections/deletions are handled before restored historical data is exposed again.

Any future automated retention feature requires its own design, review and tests for notification/reservation consistency, active obligations, backup handling and accidental-data-loss protection. Approval of the present manual policy does not authorize such a feature or a production deletion.
