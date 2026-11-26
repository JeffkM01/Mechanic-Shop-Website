# Mobile service booking and travel review

## Approved public arrangement

Edward visits customers. Public contact uses `contact@edsautoshop.com`; an unknown public phone remains absent. No home, dealership or storefront address is published.

The approved wording is: “Mobile mechanic serving the St. Louis area and selected Illinois locations, generally within about a 50-minute drive of St. Charles, Missouri. Coverage depends on the location and travel arrangements; mechanic review is required.” This is qualified coverage wording, not a guaranteed radius, a promise to serve all Illinois, a price, or an automatic geographic check.

`contact.mobileService` retains its optional schema-version-1 public fields `serviceArea` and `visitInstructions`. The approved email-only mobile contact needs no public phone or street address. Those public fields must never contain a private customer address, credentials or appointment details. The cancellation policy remains cancellation until the scheduled start with no fee; publication approval is recorded in the public profile. The owner-approved privacy policy provides manual review after two years from the scheduled appointment date, or 90 days from that date for declined/cancelled requests, with exceptions for outstanding work or required records; see [the retention procedure](privacy-requests-and-retention.md). No automatic erasure is implemented.

## New customer requests

The server publishes the active mobile policy through `/api/services` and scheduling metadata. The customer form requires **service city, state (MO/IL), and ZIP code** when this policy is active. Both React and Express validate those fields. The scheduling service validates them again before reserving capacity. Format checks do not establish that a ZIP belongs to a city/state, that the site is suitable, or that Edward can reach it.

New records receive a private `mobileVisit` snapshot containing the normalized city/state/ZIP, reserved travel allowance and eventual mechanic review. The customer cannot supply review timestamps or choose a different approval rule. The field is excluded from ordinary queries, public availability and unauthenticated response DTOs; authenticated staff can review it and authorized notification recipients receive a limited location summary. It contains no full street address. Full address/site access are arranged privately through the shop inbox before the mechanic acknowledges review.

Unsent location details stay in page memory. They are preserved across service/calendar corrections and are not written to localStorage/sessionStorage. Invalid or stale policy/availability cannot silently turn a mobile request into an automatically confirmed booking.

## Travel allowance and capacity

The reviewed **provisional minimum is 75 minutes after each new mobile service**, configured once in `shared/mobileBooking.js`. It reflects roughly 50 minutes driving plus 15 minutes for arrival/setup, rounded up. It is a planning allowance, not a price, travel charge, guaranteed arrival time or repair duration. Check the actual route between consecutive customers: two customers each about 50 minutes from St. Charles may be much farther apart.

Availability, day/month calendars and booking submission use the greater of this mobile minimum and the saved global appointment buffer. Existing saved settings are not rewritten; a saved buffer of 0 does not remove the mobile allowance. The dashboard explains the effective rule. Service time plus travel must fit working hours and avoid lunch, blocks and occupied capacity. Configured start increments can push the next offered start later still.

The mechanic can increase a request's recorded travel allowance up to 120 minutes during approval, never shorten its already reserved time. The backend rechecks the extension inside the existing MongoDB compare-and-swap reservation operation before confirming. A concurrent booking or approval cannot take the protected interval. An extension that conflicts with lunch, closing, blocked time or another request fails clearly and leaves the customer request pending.

Use reviewed blocked periods for additional one-off unavailability where the calendar permits. Do not delete or shorten somebody else's reservation to fit a route. Review the first/last trip, access and return travel too. Routes that cannot fit need a different arrangement agreed with the customer; no replacement appointment is created automatically.

## Mechanic approval

Every **new mobile request**, including Wiper Blade Replacement, stays pending until the mechanic confirms:

1. Coverage, the privately arranged service address and site access have been checked.
2. The actual route between appointments has been checked and enough travel time reserved.

The confirmation dialog sends these acknowledgments and the chosen buffer. The server enforces them even if a caller bypasses React or the factory is later configured without mobile mode. A saved review timestamp is written only with the durable confirmation. The acknowledgments record a human review; they do not claim a map/routing provider has verified the route.

Saved global automation and per-service eligibility are retained rather than silently overwritten, but they do not automatically confirm new mobile records. The dashboard labels these retained settings honestly. Historical non-mobile requests and already confirmed appointments retain their original snapshots/statuses and can still be reviewed at historical off-grid times under existing conflict/capacity rules. No historical mobile metadata is invented or backfilled.

## Operations and launch

`mobileVisit` is an optional private MongoDB subdocument; no record migration or new reservation index is required. Existing Mongo-backed reservation serialization, pending-hold expiry, decline/cancellation history, session security, CSRF, retries and scoped email tests remain in place. Management links still authorize only one appointment and must stay private.

For owned-inbox staging tests, create a new fictional mobile request, wait for receipts, and approve through the new review dialog. Wipers should also remain pending. Test a travel extension that conflicts with another reservation and verify that the pending request and other reservation remain intact.

Keep protected staging until the approved policy’s manual operating responsibilities and [production operations](production-operations-checklist.md) are verified. Host configuration, completed backups, an isolated restore drill and working alert recipients remain owner-operated checks; repository tests do not verify them. Ordinary production mail still needs its own reviewed configuration and a clean production database/reconciliation plan. No purchase, deployment, real email or database access is authorized by this runbook.
