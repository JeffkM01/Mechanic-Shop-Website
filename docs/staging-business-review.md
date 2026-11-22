# Business decisions for staging and public launch

Review recorded November 17, 2026. This document records supplied information and unresolved decisions; it does not approve unknown facts, modify saved settings, create provider accounts, or authorize a public launch.

## What is known

- Edward is an independent/mobile mechanic who currently receives work through a dealership. The website is probably intended for individual vehicle owners; that audience still needs a final decision.
- The user tentatively described the service area as St. Louis and up to about an hour into Illinois. This is **not** a verified city/ZIP list, travel policy, service radius, or commitment to perform repairs at customer homes.
- The user allows clearly labeled phone/email placeholders for the staging review. No real public phone, email, shop address, or approved service location has been supplied. Do not invent one, publish a home/dealership address, or use an unowned mailbox.
- Wiper Blade Replacement does **not** require mechanic approval in the current saved configuration. It remains the only automatic-eligible service. Other scheduler safeguards still apply.
- The user accepts the current cancellation behavior: before the appointment starts, no cancellation fee. Public wording still needs a named owner review/effective date; do not infer a data-retention decision from this acceptance.
- Render account access exists on a free account. MongoDB Compass is installed; an Atlas account/deployment has not been established by that fact. No paid plan, region, budget, or live provider setup is approved here.

## Approved saved scheduling values

This is a **non-executable reference**, not a complete settings export. The user supplied these current database values and said Edward approved them. Do not replace an existing database's settings with older repository seed defaults.

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

First decide where each type of work occurs: an approved agreed location, customer property if actually offered, or another arrangement. Then approve exact service-area boundaries, any travel limits/charges, and who checks access/safety/site suitability. Obtain permission before naming a dealership as a service location. Do not advertise a storefront or customer-home visits until that arrangement is confirmed.

The smallest safe first workflow is to collect a private service ZIP/general area, have Edward verify the location and travel time before finalizing a mobile visit, and reserve any necessary travel time through reviewed blocks/buffers. Keep street addresses out of public availability and ordinary logs. Collect a full address only when necessary for an accepted arrangement, through an approved private process.

That proposal affects the already-approved automatic Wiper flow: agree whether automatic bookings are restricted to one confirmed location or need location/travel checks before enabling public mobile bookings. Do not silently disable the approved setting or imply that current automatic confirmations already check travel. The restricted synthetic staging preview may exercise the existing rule, but it must not be advertised as real mobile availability. Implementing a location/travel workflow is pending Edward's decision, not part of a fictional completed launch.

## Public wording drafts

These are review drafts with explicit unresolved placeholders. Do not mark the source-controlled business profile approved or insert them as final public policy until the missing facts are resolved.

**Contact / location draft:** “Contact details are being prepared. Service area and appointment location will be confirmed before public booking opens.” For actual launch, replace this with an owned contact channel and the approved work arrangement. Do not use a fictitious telephone number, clickable placeholder inbox, street address, or customer-home service promise.

**Booking draft:** “Appointment times reserve estimated service time, not guaranteed repair completion. Only eligible Wiper Blade Replacement requests may be automatically confirmed when the saved scheduling safeguards are met. Other requests require mechanic approval. Pending time reservations last 24 hours; your request remains on file after expiry, and availability must be checked again before approval.” Add the approved location/travel wording before mobile bookings go public.

**Cancellation draft:** “You may cancel a pending or confirmed appointment before its scheduled start time without a cancellation fee. Use your secure appointment-management link, or contact the shop if the link is unavailable.” Add the actual contact route and effective date after review. Do not promise an automatic refund/payment feature; none exists here.

**Privacy draft:** “We use the contact, vehicle, service, scheduling, and other information you submit to manage appointment requests and communications. Our planned service providers are Render for application hosting, MongoDB Atlas for database storage, and Brevo for appointment email. Provider selection/configuration must be confirmed before this draft becomes final. We retain records for [Edward-approved period and exceptions]. To request a correction or deletion, contact [owned monitored inbox]. We review requests manually, verify identity using an appropriate private process, and explain any records that must be retained for outstanding work or applicable obligations. The website does not provide automatic record deletion.”

Edward must choose a retention period for appointment records, declines/cancellations, notification history, and backups that fits actual business and legal/accounting/dealership obligations. No universal mechanic-shop duration or suggested example is approved by this document. Do not promise to erase an entire appointment or scheduling-ledger fragment without reviewing consistency, active commitments, and required retention.

## Decisions that still block public launch

| Decision / evidence | Current status |
| --- | --- |
| Owned, monitored public contact email and phone/contact arrangement | Placeholders allowed only for staging. Email-only launch would need a deliberate profile/UI validation change; current profile requires phone, email, and address to mark contact confirmed. Do not insert a false address to satisfy it. |
| Audience, exact service area, actual work location, permission to publish any location | Unresolved; tentative St. Louis/Illinois description only. |
| Travel time and eligibility for automatic mobile Wiper bookings | Not modeled; owner decision required. |
| Actual weekly hours, breaks, closures, blocks in intended database | Saved approval reported, actual geometry not supplied in the snapshot. |
| Provisional services and service-copy accuracy | Tire Rotation and Cabin Air Filter remain provisional; review wording/availability. |
| Final cancellation wording and effective date | Current behavior accepted by user; complete owner publication review. |
| Retention, corrections/deletion inbox, identity check, backup retention | Undecided; no automated deletion promised. |
| Provider account/region/plan/budget and agreements | Proposed Render/Atlas/Brevo; verify actual selection and billing before purchase. |
| Least-privilege DB user, network/TLS, secrets, secure proxy/cookies | Must be configured and verified on the actual approved host. |
| Controlled sender/reply inbox and deliverability | Preview email stays disabled; real send requires separate approval. |
| Protected backups, isolated restoration, alerts and rollback | Runbooks exist; hosted drills remain unperformed. |

Keeping the checked-in `shared/businessProfile.json` unapproved is intentional while these facts remain unknown. `npm run check:launch` should continue to report public-launch blockers; passing lint/build/tests does not override them.
