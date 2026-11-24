# Controlled Brevo email connection test

This runbook prepares one operator-triggered delivery test. It does not authorize a deployment, purchase, real customer email, queue replay, or public launch. Review the code and deployment revision before changing the host configuration. No message is sent by CI, startup, sign-in, or saving configuration.

The owner reports that `edsautoshop.com` and its `www` redirect work, Zoho Mail can send and receive at `contact@edsautoshop.com`, and Brevo domain authentication is complete. Those milestones do not establish that the deployed application can deliver a message through Brevo.

## What the test does

The optional mechanic-dashboard **Email connection test** sends one clearly labeled synthetic message through Brevo's HTTPS transactional API. The sender, recipient, and Reply-To are fixed to `contact@edsautoshop.com`; the sender name is `Ed's Auto Shop`. There is no recipient picker or editable message.

The test does not read appointments, change appointment status, create a booking or management link, start the notification dispatcher, or drain pending messages. Protected staging continues to disable ordinary appointment notifications and management-link issuance, including when a Brevo API key is present. Submitting an appointment therefore still will not send its normal receipt in this environment.

The API endpoint is fixed to `https://api.brevo.com/v3/smtp/email`, with HTTPS, redirects rejected, and a bounded request timeout. It uses an API key, not a Zoho password or Brevo SMTP key. This avoids requiring an outbound SMTP connection, but actual host connectivity and provider authorization must still be tested.

## Prepare the reviewed staging revision

1. Review the feature PR and its successful automated checks. If accepted, merge and manually deploy the reviewed revision to the existing restricted staging service. Keep automatic deployment off; do not create another service or change plans for this test without a separate cost review.
2. Keep `DEPLOYMENT_STAGE=staging`, the staging gateway password, the isolated staging database, and the existing mechanic/session protections. Keep stable management secrets unchanged. Do not switch the deployment stage to production to enable email.
3. Confirm control of the `contact@edsautoshop.com` inbox and the Brevo sender/domain in the owner's accounts. The probe is deliberately limited to that reviewed address; changing recipient requires another reviewed code change.
4. Create or obtain the appropriate transactional-email API key privately in Brevo. Store it only in the host's server-side secret controls. Never paste the key, passwords, connection strings, or complete environment screenshots in chat, GitHub, shell history, frontend settings, or `VITE_` variables.

## Private runtime settings

In the existing Render service's private environment settings, review these additions:

| Setting | Value / handling |
| --- | --- |
| `DEPLOYMENT_STAGE` | Keep `staging`. |
| `STAGING_EMAIL_TEST_ENABLED` | Explicitly set `true` only for the reviewed controlled test. Unset or `false` keeps it disabled; enabling it outside protected staging is rejected. |
| `BREVO_API_KEY` | The private Brevo transactional API key. This is not an SMTP password or the Zoho mailbox password. |

The test's sender, recipient, and Reply-To are fixed by the server, so do not add SMTP credentials or guess additional sender settings to activate it. Setting `EMAIL_TRANSPORT` is not needed for this isolated probe; its transport is always Brevo HTTPS. Preserve the working Zoho MX/SPF/DKIM and Render DNS records.

Apply runtime changes only through the owner's reviewed deployment/restart procedure. Expect to sign into the mechanic dashboard again after a restart. The feature remains manual: enabling configuration alone does not send anything.

## Send and verify one message

1. Open the protected staging website over HTTPS and pass the staging gateway. Sign into `/mechanic` with the separate mechanic password.
2. Locate **Email connection test** and confirm the displayed destination is `contact@edsautoshop.com`. The panel is hidden when the optional test is disabled or unavailable.
3. Click **Send test email** once. The POST requires the current mechanic session and CSRF token. Caller-supplied recipient/message overrides are rejected.
4. Read the result. **Accepted** means Brevo accepted the request; it does not mean the message has reached the mailbox. Check Zoho's inbox and spam folder, the From address/name, and Reply-To. Test a reply only through an operator-controlled mailbox.
5. Record the reviewed app revision, test time, acceptance result, and actual mailbox outcome privately. Do not record API keys or private customer data. When finished, unset `STAGING_EMAIL_TEST_ENABLED` or set it to `false` through the reviewed runtime-change procedure. Keep protected staging enabled.

The server admits at most one attempt per minute per running process, reserving the cooldown before awaiting transport. Concurrent clicks share that admission. Browser disabling is a convenience; the backend enforces the limit. A restart resets this process-local cooldown. It is not a distributed quota or a guarantee of exactly-once delivery.

## Failure and uncertain results

- Authentication/sender rejection: review the private Brevo key, account permissions, authenticated domain, and authorized sender. Do not resolve a rejection by disabling TLS or substituting a personal password.
- Provider quota or cooldown: wait for the stated retry interval and review the provider account. Repeated clicks do not bypass the server's admission limit.
- Network timeout or lost response: acceptance may be uncertain even if the UI reports failure. Check the inbox/provider privately before another attempt; repeating a test can produce a duplicate clearly labeled message.
- Accepted but no inbox message: check spam and the provider's delivery events privately. A successful HTTP request is not proof of inbox delivery.

Errors and logs must retain fixed safe advice rather than raw provider responses, API keys, headers, or message contents. The probe does not persist delivery history in appointment records. An in-flight message cannot be recalled; disabling the feature prevents later admissions.

## What remains before appointment email and public launch

This probe tests the hosting-to-provider connection and the owned mailbox only. It does not verify saved appointment receipts, mechanic notices, approval/decline/cancellation messages, durable retry acknowledgement, or secure management-link exchange. Those flows still need a separately reviewed end-to-end test with synthetic appointments, protected owned recipients, and reconciliation of old pending notification intents before enabling a dispatcher. Do not turn on the ordinary queue against accumulated synthetic records without that review.

For a later approved non-preview deployment, `EMAIL_TRANSPORT=brevo_api` selects the HTTPS adapter using private `BREVO_API_KEY`, reviewed `MAIL_FROM`, and `MECHANIC_NOTIFICATION_EMAIL`; SMTP credentials are unnecessary for that mode. Leaving `EMAIL_TRANSPORT` unset preserves the existing SMTP transport and its `SMTP_*` requirements. Both transports retain durable queue/backoff and at-least-once acknowledgement semantics. Changing transport does not itself authorize delivery.

Render Free may idle, so this change does not establish reliable continuously running notification retries or production uptime. Confirm the selected plan, worker topology, provider limits, monitoring, protected backups/recovery, and unresolved mobile-travel/contact/privacy policies before public launch. A successful connection test does not clear those launch blockers.
