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

## Mobile booking update — November 25, 2026 (America/Chicago)

The owner approved the qualified St. Louis/selected Illinois area, using **St. Charles, Missouri** as the base and approximately 50 minutes driving as a general reach. Public mobile contact and visit instructions are now approved, with no phone or public street address. The booking form collects city/state/ZIP privately; Edward reviews the actual full address/site access and route before confirmation.

New mobile bookings reserve a provisional minimum **75 minutes after service**, or a larger saved buffer. All new mobile requests, including wipers, require recorded mechanic location/travel review. Approval can increase the allowance up to 120 minutes only after atomic conflict revalidation. Existing saved hours, capacity, global buffer and automation are not rewritten; historical requests retain their original rules. The earlier tables below describe the supplied saved configuration, not an override of the new effective mobile policy. See [mobile booking rules](mobile-service-planning.md).

The owner accepted cancellation until the appointment starts with no fee, and the corresponding public policy is approved. The privacy contact/request wording and actual provider names are prepared; the retention decision was subsequently approved as recorded below. Hosted backups, recovery and alerts remain unverified.

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

## Current mobile workflow

The form now collects a private city, state and ZIP. Express and scheduling revalidate those fields before reservation. The mechanic checks actual coverage, privately arranged address/site access and the route before confirming. The server requires those acknowledgments, reserves at least 75 minutes after new mobile service, and can extend that reservation up to 120 minutes only after atomic conflict checks. It does not calculate driving routes or automatically verify ZIP-to-city correspondence.

The approved qualified service area is based on **St. Charles**, not St. Peters. A trip from the base is not the same as the trip between consecutive customers. Saved global automation and wiper eligibility remain on file, but every new mobile request requires review. Historical appointments retain their original snapshots. See [mobile service planning](mobile-service-planning.md).

## Public policies and remaining decisions

Public email-only mobile contact, coverage/visit instructions and cancellation until the scheduled start without a fee are approved in the source profile. No phone or public street address is invented. Provider descriptions identify Render, MongoDB Atlas, Brevo and Zoho Mail; correction/deletion requests go to `contact@edsautoshop.com` for private identity verification and manual review. This does not promise automatic deletion, a replacement time, refunds or a new payment feature.

The owner approved manual review for deletion two years after the scheduled appointment date, or 90 days after that same date for declined/cancelled requests, with exceptions for outstanding work or required records. Privacy wording and its effective date are now approved in the source profile. There is no automatic deletion job. Backup retention and any actual cleanup execution remain separate operator responsibilities; see [privacy requests and retention](privacy-requests-and-retention.md).

## Decisions that still block public launch

| Decision / evidence | Current status |
| --- | --- |
| Owned, monitored public contact email and phone/contact arrangement | `contact@edsautoshop.com` is supplied and mailbox send/receive passed according to the owner. `contact.emailConfirmed` can publish that inbox alone. Phone remains absent at the owner's request. Email-only mobile contact, qualified St. Charles-based coverage and visit instructions are approved in the source profile; privacy wording is now approved; actual operational checks remain outstanding. |
| Audience, exact service area, actual work location, permission to publish any location | Qualified St. Louis/selected Illinois coverage generally within about 50 minutes of St. Charles is approved. Actual city/ZIP, private address/site suitability and the trip between customers are checked for each request; no automatic geographic validation is claimed. |
| Travel time and eligibility for automatic mobile Wiper bookings | New mobile records reserve at least 75 minutes after service and require mechanic location/travel review, including wipers. Saved automation remains on file but cannot bypass mobile approval. Historical records are preserved. |
| Actual weekly hours, breaks, closures, blocks in intended database | Saved approval and a deployed-dashboard review are owner-reported; actual geometry was not supplied in the snapshot or independently inspected. |
| Provisional services and service-copy accuracy | Tire Rotation and Cabin Air Filter remain provisional; review wording/availability. |
| Final cancellation wording and effective date | Approved: cancellation until scheduled start with no fee. Source profile records the owner-review date. |
| Retention, corrections/deletion inbox, identity check, backup retention | Approved: private correction/deletion requests through the shop inbox and manual review after two years, or 90 days for declined/cancelled requests, counted from the scheduled date. Actual cleanup, backup retention and operator follow-through still need review; no automatic deletion is promised. |
| Provider account/region/plan/budget and agreements | Owner reports Free Render, Atlas, Porkbun domain, and Zoho inbox setup. Brevo supports the controlled synthetic mail flow; production settings remain under review. Confirm current plans, agreements, and any future paid quote; no repurchase or Blueprint import is required for this preview. |
| Least-privilege DB user, network/TLS, secrets, secure proxy/cookies | Owner reports connected health and working staging. Account roles, network restrictions, and proxy/cookie behavior still require actual-host verification. |
| Controlled sender/reply inbox and deliverability | Owner reports the Brevo connection probe and scoped synthetic receipts, manual confirmation, decline, customer cancellation and mechanic cancellation reached the owned inbox. The customer-cancellation flow was exercised through secure appointment access. Automatic Wiper delivery, management sign-out, production configuration and ongoing retry operation need separate verification. Keep test flags off outside intentional protected testing. |
| Custom-domain HTTPS and email transport | Owner reports apex and `www` routing/TLS work. Brevo HTTPS was exercised by the scoped synthetic email flow; SMTP remains an optional legacy transport. Actual host/proxy verification and dependable retry operation remain separate checks; Free idling does not establish continuous notification delivery. See [Render staging](render-staging.md#connect-the-purchased-domain-without-disturbing-zoho). |
| Protected backups, isolated restoration, alerts and rollback | Runbooks exist; hosted drills remain unperformed. |

The owner-approved source profile includes contact, privacy/retention and cancellation wording. This approval is separate from actual hosted operations: `npm run check:launch` never grants public-launch approval, and backups, isolated recovery, alerts, delivery and other live checks still require owner evidence. Passing lint/build/tests does not override them.
