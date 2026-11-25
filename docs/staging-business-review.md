# Business decisions for staging and public launch

Review updated November 25, 2026, using owner-reported progress. This document records supplied information and unresolved decisions; it does not independently inspect provider accounts, approve unknown facts, modify saved settings, send email, or authorize a public launch.

## What is known

- Edward is an independent/mobile mechanic who currently receives work through a dealership. The website is probably intended for individual vehicle owners; that audience still needs a final decision.
- The user has confirmed that Edward visits customers as a mobile mechanic. Exact service-area boundaries, site suitability, and travel arrangements remain unresolved. The tentative St. Louis/up-to-about-an-hour-into-Illinois description is **not** a verified city/ZIP list, travel policy, service radius, or promise that every customer location is suitable.
- The owner reports purchasing `edsautoshop.com` through Porkbun, setting up Zoho Mail for `contact@edsautoshop.com`, and successfully testing incoming mail and replies. This is the supplied approved public inbox. A public business phone is still unknown; Edward plans a separate phone/number. No public storefront, home, or dealership address is approved.
- The optional schema-version-1 `contact.emailConfirmed` flag publishes this reviewed email independently while aggregate `contact.confirmed` remains false. It does not approve unknown phone/location information or make the site ready for launch. Domain ownership and mailbox delivery do not establish custom-domain website routing or Brevo delivery.
- Wiper Blade Replacement does **not** require mechanic approval in the current saved configuration. It remains the only automatic-eligible service. Other scheduler safeguards still apply.
- The user accepts the current cancellation behavior: before the appointment starts, no cancellation fee. Public wording still needs a named owner review/effective date; do not infer a data-retention decision from this acceptance.
- PRs #15 and #16 are merged. The owner reports that the existing manually selected **Free** Render preview at `https://mechanic-shop-website.onrender.com` works, `/api/health` reports `connected`, and deployed booking settings and the synthetic appointment/staff workflow have been checked. This does not independently verify database permissions, real DNS/TLS, proxy security, notification delivery, backups, or monitoring. No additional paid plan or purchase is authorized here. The legacy paid `starter` Blueprint is not the owner's current manual Free configuration.

## Mobile contact update — November 25, 2026

The owner explicitly requested removal of the unknown public phone placeholder and confirmed that Edward visits customers. The public profile now identifies mobile service, leaves the phone absent, and asks customers to email a city/ZIP and service request to discuss location and travel before booking. It does not publish a home, dealership, or storefront address. The optional mobile profile supports future approved email-only contact; aggregate contact and privacy/cancellation approval flags remain unchanged.

The latest area description is still tentative: probably the St. Louis area, with some Illinois trips. It is not approval to advertise all of St. Louis, all Illinois, a one-hour radius, a travel charge, or a guaranteed arrival window. No definite geographic coverage is published while `mobileService.serviceArea` is null. Exact boundaries and the private visit-location process remain owner decisions.

See [mobile service planning](mobile-service-planning.md) for proposed travel allowances and existing buffer/blocked-time controls. These are advice, not changes to saved scheduling or automatic Wiper eligibility.

## Approved saved scheduling values

This is a **non-executable reference**, not a complete settings export. The user supplied the snapshot below and said Edward approved it, then reported reviewing the deployed settings. No new full settings export was supplied. Review the intended database directly before treating this historical snapshot as an exact current export. Do not replace an existing database's settings with older repository seed defaults.

| Setting | Supplied current value |
| --- | --- |
| Automatic booking | Enabled |
| Hours / capacity verification | Marked verified in the saved dashboard |
| Timezone | `America/Chicago` |
| Simultaneous appointment capacity | 1 |
| Maximum automatic confirmations | 3 per appointment date |
| Minimum notice | 24 hours |
| Booking horizon | 30 days |
| Start increment | 60 minutes |
| Buffer | 0 minutes |
| Pending provisional hold | 24 hours |

The actual weekly hours, lunch/break geometry, closed dates, and manually blocked periods were **not included** in the supplied dashboard text. Verification labels alone do not reconstruct them. Review the saved calendar directly before copying settings into a fresh staging database or making any production change.

| Service | Active / provisional | Booking estimate | Approval |
| --- | --- | --- | --- |
| Oil Change | Inactive | 60 minutes | Manual |
| Tire Rotation | Active, provisional | 60 minutes | Manual |
| Cabin Air Filter Replacement | Active, provisional | 30 minutes | Manual |
| Engine Air Filter Replacement | Active | 30 minutes | Manual |
| Wiper Blade Replacement | Active | 30 minutes | Automatic-eligible; individual approval checkbox is unchecked |
| Brake Repairs | Active | 120 minutes | Manual |
| AC & Heating Repair | Active | 120 minutes | Manual |
| Engine Diagnostics | Active | 60 minutes | Manual |
| Other / Not Sure | Appointment selection only | 120 minutes | Manual |
| Suspension Repair | Active | 103 minutes | Manual |

Do not round the supplied 103-minute suspension estimate or restore the old 90-minute diagnostics estimate. These reserve calendar time and do not promise repair completion times or set prices. Confirm the two provisional service labels and outdated “Edward still needs to confirm” wording before revising customer copy; do not silently remove provisional status because the global schedule was approved.

Automatic confirmation also requires verified hours/capacity, an active nonprovisional eligible Wiper service, its individual approval rule off, an available slot, and the per-appointment-date automatic cap. Enabling automation does not automatically approve a pending backlog. An expired pending hold releases capacity but retains the request; mechanic confirmation must revalidate availability. Cancellation does not refund historical automatic-admission count, and manual approvals may exceed that separate automatic cap while still respecting capacity.

## Smallest mobile-booking adaptation to review

The current form has no dedicated private service-location field and the scheduler does not calculate travel time. A proposed area “about an hour away” is not a scheduling rule. A 30-minute Wiper slot with zero buffer cannot account for an unreviewed two-hour round trip.

Customer visits have been confirmed as the general work arrangement. Still approve exact service-area boundaries, any travel limits/charges, and who checks access/safety/site suitability before finalizing individual visits. Obtain permission before naming a dealership as a service location; do not advertise a storefront or imply all customer properties can support the requested work. A suggested 30-minute travel buffer is a planning proposal only, not an approved setting or a guarantee that trips into Illinois fit that estimate. Do not silently replace the approved zero-minute buffer with it.

The smallest safe first workflow is to collect a private service ZIP/general area, have Edward verify the location and travel time before finalizing a mobile visit, and reserve any necessary travel time through reviewed blocks/buffers. Keep street addresses out of public availability and ordinary logs. Collect a full address only when necessary for an accepted arrangement, through an approved private process.

That proposal affects the already-approved automatic Wiper flow: agree whether automatic bookings are restricted to one confirmed location or need location/travel checks before enabling public mobile bookings. Do not silently disable the approved setting or imply that current automatic confirmations already check travel. The restricted synthetic staging preview may exercise the existing rule, but it must not be advertised as real mobile availability. Implementing a location/travel workflow is pending Edward's decision, not part of a fictional completed launch.

## Public wording drafts

These are review drafts with explicit unresolved placeholders. Do not mark the source-controlled business profile approved or insert them as final public policy until the missing facts are resolved.

**Contact / location draft:** “For appointment questions, email contact@edsautoshop.com. Edward is a mobile mechanic who visits customers; the service area, visit location, and travel arrangements need confirmation for the requested work.” The inbox is owner-reported as tested and may be published independently. Exact area, travel, and site-review wording still need approval. Do not invent a telephone number or publish a home/dealership address.

**Booking draft:** “Appointment times reserve estimated service time, not guaranteed repair completion. Only eligible Wiper Blade Replacement requests may be automatically confirmed when the saved scheduling safeguards are met. Other requests require mechanic approval. Pending time reservations last 24 hours; your request remains on file after expiry, and availability must be checked again before approval.” Add the approved location/travel wording before mobile bookings go public.

**Cancellation draft:** “You may cancel a pending or confirmed appointment before its scheduled start time without a cancellation fee. Use your secure appointment-management link, or contact the shop if the link is unavailable.” Add the actual contact route and effective date after review. Do not promise an automatic refund/payment feature; none exists here.

**Privacy draft:** “We use the contact, vehicle, service, scheduling, and other information you submit to manage appointment requests and communications. Our selected providers include Render for application hosting, MongoDB Atlas for database storage, and Zoho Mail for business correspondence. Brevo processes automated appointment messages when enabled; ordinary appointment email stays disabled in protected staging outside an explicitly configured owned-inbox workflow test. Provider configuration, agreements, and this wording must be reviewed before the notice becomes final. We retain records for [Edward-approved period and exceptions]. To request a correction or deletion, email contact@edsautoshop.com. The proposed process is a manual review with an appropriate private identity check and an explanation of any records that must be retained for outstanding work or applicable obligations. The website does not provide automatic record deletion.”

Edward must choose a retention period for appointment records, declines/cancellations, notification history, and backups that fits actual business and legal/accounting/dealership obligations. The suggested two years for past appointments and 90 days after the requested date for declined/cancelled requests are **unapproved proposals**, as is the detailed manual request/cleanup procedure. No universal mechanic-shop duration or suggested example is approved by this document. Do not promise to erase an entire appointment or scheduling-ledger fragment without reviewing consistency, active commitments, and required retention. Keep the privacy approval false even though a working request-contact inbox now exists.

## Decisions that still block public launch

| Decision / evidence | Current status |
| --- | --- |
| Owned, monitored public contact email and phone/contact arrangement | `contact@edsautoshop.com` is supplied and mailbox send/receive passed according to the owner. `contact.emailConfirmed` can publish that inbox alone. Phone remains absent at the owner's request. The mobile profile supports reviewed email-only contact without a street address, but exact service area/visit instructions and aggregate `contact.confirmed=false` remain launch blockers. |
| Audience, exact service area, actual work location, permission to publish any location | Customer visits are confirmed as the general mobile arrangement. Audience, exact cities/ZIPs, individual visit/site suitability, and travel boundaries still need review; St. Louis/Illinois wording remains tentative. |
| Travel time and eligibility for automatic mobile Wiper bookings | Not modeled; owner decision required. |
| Actual weekly hours, breaks, closures, blocks in intended database | Saved approval and a deployed-dashboard review are owner-reported; actual geometry was not supplied in the snapshot or independently inspected. |
| Provisional services and service-copy accuracy | Tire Rotation and Cabin Air Filter remain provisional; review wording/availability. |
| Final cancellation wording and effective date | Current behavior accepted by user; complete owner publication review. |
| Retention, corrections/deletion inbox, identity check, backup retention | Working public inbox identified; retention, request verification, cleanup, and backup-retention procedure remain unapproved. No automated deletion promised. |
| Provider account/region/plan/budget and agreements | Owner reports Free Render, Atlas, Porkbun domain, and Zoho inbox setup. Brevo supports the controlled synthetic mail flow; production settings remain under review. Confirm current plans, agreements, and any future paid quote; no repurchase or Blueprint import is required for this preview. |
| Least-privilege DB user, network/TLS, secrets, secure proxy/cookies | Owner reports connected health and working staging. Account roles, network restrictions, and proxy/cookie behavior still require actual-host verification. |
| Controlled sender/reply inbox and deliverability | Owner reports the Brevo connection probe and scoped synthetic receipts, manual confirmation, decline, customer cancellation and mechanic cancellation reached the owned inbox. The customer-cancellation flow was exercised through secure appointment access. Automatic Wiper delivery, management sign-out, production configuration and ongoing retry operation need separate verification. Keep test flags off outside intentional protected testing. |
| Custom-domain HTTPS and email transport | Owner reports apex and `www` routing/TLS work. Brevo HTTPS was exercised by the scoped synthetic email flow; SMTP remains an optional legacy transport. Actual host/proxy verification and dependable retry operation remain separate checks; Free idling does not establish continuous notification delivery. See [Render staging](render-staging.md#connect-the-purchased-domain-without-disturbing-zoho). |
| Protected backups, isolated restoration, alerts and rollback | Runbooks exist; hosted drills remain unperformed. |

Keeping the checked-in `shared/businessProfile.json` unapproved is intentional while these facts remain unknown. `npm run check:launch` should continue to report public-launch blockers; passing lint/build/tests does not override them.
