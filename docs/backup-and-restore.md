# Database backup and recovery runbook

This is an operator-reviewed procedure, not an automated backup job or evidence that recovery works. No backup, restore, production database access, or email delivery is performed by `npm run check:launch` or by the automated tests. Complete and record an isolated restore drill before depending on this plan for a public launch.

## Prefer a managed recovery service

For a small shop, use the database provider's supported scheduled backups and recovery controls when the chosen plan includes them. Verify the actual plan, backup frequency, retention, encryption, restore destination, access controls, and alerting; do not assume a free database tier includes backups. Have an owner-approved retention and recovery policy, including who can access backups and how much recent work could be lost. Keep encrypted recovery material separate from the app's source repository and database credentials.

Use a new, isolated recovery database for every drill. Never run a restore against the live shop database merely to test the instructions. A successful dump or an archive file existing on disk is not proof of a successful restore.

## What must remain consistent

Back up the **entire shop database**, including `appointments`, `schedulingstates`, collection metadata, and indexes. Appointment status, cancellation/decline history, management grant verifiers, notification intent, and the reservation ledger form one logical system. Restoring one collection without the others can make the schedule inconsistent.

With the current standalone-compatible design, quiesce **all writers** for a consistent full-database dump: stop new HTTP admissions, wait for graceful API shutdown and any in-flight email acknowledgement, and stop maintenance scripts or other workers. Keep exactly one API/notification dispatcher when operation resumes. A plain dump taken while these separate documents are changing is not guaranteed to capture a consistent scheduling snapshot. If the provider offers a documented consistent snapshot or point-in-time recovery alternative, follow that provider's procedure instead.

Backups contain private customer information and sensitive authorization metadata even though raw management bearers are not stored. Protect them with encryption, restricted permissions, appropriate retention, and controlled off-site storage. Keep the management secret and encryption private key in separate protected secret storage, not inside the database archive or source repository.

## Optional encrypted MongoDB-tools backup

The following example is for an approved **Linux recovery machine or WSL shell**, not the normal PowerShell project terminal. It requires compatible MongoDB Database Tools, `age`, protected storage, and an operator-reviewed connection configuration. It has not been executed against a real database as part of this change. Prefer the provider's managed procedure if you do not maintain this tooling.

1. Create restricted directories with `umask 077`. Keep Mongo tools configuration and encryption material under `.private/`; keep local encrypted artifacts under `backups/`. These directories must remain excluded from Git, Docker build context, website assets, and log uploads.
2. Put the MongoDB URI in `.private/backup.yml` using the tools' supported `uri` configuration field. Include the intended shop database in that URI and use a backup account with only the needed read/backup permissions. Do not place the URI in a command-line argument, shell history, issue, screenshot, or ordinary application log.
3. Put the approved encryption **public recipient** in `.private/backup-recipients.txt`. Keep the decryption private identity in a different protected recovery location. Verify recipient ownership before use; losing its private identity makes the backup unrecoverable.
4. Quiesce the API, notification worker, and other writers, then run the reviewed command below. The private log files may contain sensitive tool errors and must not be uploaded or pasted into chat.

```bash
set -euo pipefail
umask 077
mkdir -p .private backups

backup_stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_file="backups/eds-shop-${backup_stamp}.archive.gz.age"
backup_partial="${backup_file}.partial"

mongodump --config=.private/backup.yml --archive --gzip \
  2>.private/backup-dump.log \
  | age -R .private/backup-recipients.txt -o "$backup_partial" \
    2>.private/backup-encryption.log

# Only a completely successful pipeline is promoted to a usable backup name.
mv -- "$backup_partial" "$backup_file"
sha256sum -- "$backup_file" > "${backup_file}.sha256"
```

Never select a `.partial` file for recovery. Retain failed artifacts only in protected storage until the operator investigates them. Check the exit status and private logs, verify the encrypted archive can be read by the intended recovery identity, and copy completed encrypted artifacts and integrity records to the approved off-site store. A SHA-256 checksum detects accidental changes; the archive's authenticated encryption and protected key remain the confidentiality/integrity boundary. Define retention and test deletion of expired backup copies according to the approved policy.

Resume normal operation only after the backup window has closed cleanly. Record the snapshot time, outage window, relevant application version, and recovery test result without customer contents or credentials.

## Restore drill into a fresh database only

Prepare an isolated recovery environment and restore credentials that can write **only the newly selected recovery database**. Keep production application credentials out of this environment. Prefer a separate staging cluster or local synthetic environment, and verify the actual destination with the database provider before proceeding.

Generate a new namespace and keep it for the duration of the drill:

```bash
set -euo pipefail
umask 077
recovery_target_db="eds_restore_drill_$(node -e 'process.stdout.write(require("node:crypto").randomBytes(16).toString("hex"))')"
printf 'New isolated restore database: %s\n' "$recovery_target_db"
```

Before running the restore:

- Confirm that the target is **not** the live shop database and currently has no collections. Check this with the provider/Compass using the restricted recovery account; a namespace string alone cannot prove emptiness or identify the physical cluster.
- Provision the recovery account only for the generated target database. Create `.private/restore.yml` with its supported tools `uri` field, authenticating against the appropriate auth source. For an archive namespace-remapping restore, leave the connection URI's database path empty and use the explicit `--nsFrom` / `--nsTo` below; do not combine it with a conflicting `--db` or URI database selection.
- Set `recovery_source_db` to the original database name contained in the archive and `recovery_archive` to the reviewed complete `.age` artifact. Neither variable is a URI or a password. Retrieve the decryption identity into `.private/recovery.agekey` using the approved protected procedure, then restrict its permissions. Do not print it.
- Verify the encrypted artifact's integrity and backup time. Do not extract plaintext archives to disk. Do not use `--drop`, `--preserveUUID`, or an administrator credential to make a failed drill overwrite an existing database.

The guards below constrain namespace remapping and require an explicit acknowledgement that the destination was checked. They do **not** verify the remote host, account privileges, or database emptiness; those remain operator checks.

```bash
# Set only after reviewing the source name and protected destination config.
recovery_source_db='REPLACE_WITH_ORIGINAL_DATABASE_NAME'
recovery_archive='backups/REPLACE_WITH_APPROVED_ARCHIVE.archive.gz.age'
recovery_target_confirmed_empty='no'

[[ "$recovery_source_db" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$ ]]
[[ "$recovery_target_db" =~ ^eds_restore_drill_[a-f0-9]{32}$ ]]
[[ "$recovery_source_db" != "$recovery_target_db" ]]
[[ "$recovery_target_confirmed_empty" == 'yes' ]]

age --decrypt -i .private/recovery.agekey "$recovery_archive" \
  2>.private/recovery-decryption.log \
  | mongorestore --config=.private/restore.yml --archive --gzip \
      --nsInclude="${recovery_source_db}.*" \
      --nsFrom="${recovery_source_db}.*" \
      --nsTo="${recovery_target_db}.*" \
      >.private/recovery-restore.log 2>&1
```

The intentionally incomplete values and `no` acknowledgement stop this example until the operator supplies and reviews the actual recovery plan. Do not change the target pattern to the live database name. Check the pipeline exit status and private logs; a partial restore is a failed drill and must not be promoted. Keep an unsuccessful target isolated for investigation, then remove it only through a separately reviewed, target-specific cleanup procedure.

## Validate before exposing recovered data

With outgoing SMTP disabled and the recovery API restricted from public traffic:

1. Verify collection and index presence, record counts, representative retained statuses/history, and that the appointment snapshots and scheduling ledger came from the same snapshot. Check the saved service catalog and historical aliases without rewriting original appointment names.
2. Exercise availability and explicit mechanic review/cancellation using synthetic recovery records. Verify that confirmed/held intervals remain protected and terminal records do not occupy capacity. Do not send mail to addresses from a restored customer archive.
3. Review all changes after the backup time: new requests, approvals, cancellations, blocked periods, settings, and emails may have occurred after the snapshot and therefore be missing or older in the restored copy. Reconcile them with approved operational records before relying on the recovered calendar.
4. Review queued notification flags before enabling the dispatcher. A restored pending flag may represent a message already delivered after the backup, or a request later cancelled. Restoring a database cannot recall emails or guarantee exactly-once delivery.
5. Rotate `APPOINTMENT_MANAGEMENT_SECRET` **before a recovered database is exposed**. Restoring an older backup can otherwise restore grants or customer sessions that were later revoked. Rotation invalidates those old links/sessions; there is no automatic historical token backfill, so staff must provide the documented contact-shop fallback. An API restart clears the current process's in-memory mechanic sessions; reassess the staff password as well if the incident involved credential compromise.
6. Keep automatic booking disabled until Edward reviews the recovered hours, capacity, current commitments, and cancellation policy. Do not restart an old verified/automation-enabled configuration and assume its calendar is current. Arrange a reviewed maintenance procedure for making these changes before customer access or email dispatch resumes.

For an actual recovery, prefer switching the application to a **newly restored and verified database** through an approved configuration change while keeping the original database intact. Plan the switchover and rollback with the provider; this runbook does not authorize an in-place production overwrite or deploy it automatically. Run one API/email worker, complete the controlled HTTPS/auth/email checks with synthetic recipients, and obtain operator approval before restoring public traffic. Keep a dated record of the drill and recovery decision without personal customer data.
