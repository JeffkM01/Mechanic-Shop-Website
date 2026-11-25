# Mobile service contact and travel planning

## Current reviewed scope

Edward is a mobile mechanic who visits customers. The owner asked to remove the unknown public phone placeholder. Contact now uses the independently approved `contact@edsautoshop.com` inbox and identifies mobile visits. There is no approved public street address. Neither a home address nor a dealership address is published.

The suggested St. Louis/Illinois area is tentative. Exact cities/ZIPs, maximum travel, suitable work locations, travel charges (if any), and the individual visit process remain unconfirmed. The website asks customers to email a city or ZIP code and the requested service to discuss coverage and arrangements before booking; it does not promise every location can be served. Do not put a customer's street address in this public profile, availability responses, URLs, or ordinary logs.

## Public profile contract

`contact.mobileService` is optional in a schema-version-1 profile and has exactly two fields:

| Field | Meaning |
| --- | --- |
| `serviceArea` | Null until reviewed, or bounded public coverage wording up to 300 characters. |
| `visitInstructions` | Null until reviewed, or public instructions up to 600 characters explaining how a visit is arranged. |

Presence identifies mobile service. Mobile profiles keep `addressLines` empty. An unknown phone is omitted from Contact; an approved real phone can later be shown. Only aggregate-approved coverage and visit instructions are published. Draft mobile contact uses a generic coverage inquiry and the existing approved email when available.

Full mobile contact approval requires email, service area and visit instructions, and can be email-only. A phone or storefront address is not required for that arrangement. Older storefront profiles retain their validation and rendering. Independent `emailConfirmed=true` does not approve coverage, travel, privacy, retention, or public launch. The actual profile keeps `contact.confirmed=false` and policy approvals false while these decisions remain unresolved.

## Travel allowance to discuss with Edward

A useful initial proposal is **30 minutes between nearby visits**, subject to actual route review. For farther visits, use the route estimate **plus 10–15 minutes for arrival/setup or uncertainty**, then round up to an appropriate allowance. An Illinois trip may require 60 minutes or more; crossing a state line is not itself a measure of distance or traffic. These are planning suggestions, not approved settings, prices, or promises to customers.

Check the trip between consecutive customers, not only each customer's distance from Edward's starting point. Two customers each one hour from that starting point may be much farther apart. Review the first trip of the day, return travel, parking/access, road conditions, and how lunch and closing time affect the day.

Illustrative examples, not shop commitments:

| Previous service ends | Estimated drive + arrival/setup | Time to reserve for travel | Earliest following start with hourly increments |
| --- | --- | --- | --- |
| 9:30 AM | 20 + 10 minutes | 30 minutes | 10:00 AM, if the rest of the calendar permits |
| 9:30 AM | 50 + 10 minutes | 60 minutes | 11:00 AM, if the rest of the calendar permits |

## Existing dashboard controls

**Booking Settings → Appointment buffer (minutes)** reserves extra time after each newly booked service and includes it in overlap/capacity checks. Its supported range is 0–120 minutes. It does not look up addresses, estimate driving routes, guarantee location suitability, or add a travel fee. Start increments, breaks, working hours and blocked time can push the next offered start later than the end of that buffer.

The last owner-supplied saved buffer was **0**. This change does not modify it or any saved hours, capacity, services, estimates, appointment statuses or automation. Existing appointments retain their duration and buffer snapshots; a changed global buffer does not rewrite previously booked visits. Review older bookings separately.

Use **Closures & Blocked Times** for reviewed one-off travel or other unavailable periods where the calendar permits. The server rejects conflicts with protected reservations; do not remove or shorten another customer's reservation to fit a route. Reserve the first trip separately if it belongs within the published working day. Pending requests provisionally occupy time and need the same planning attention as confirmed visits.

The customer form still has no dedicated private service-location field, and the backend does not validate location/travel eligibility. This PR changes public contact presentation and documentation, not routing or booking approval logic. Discuss the location privately through the approved inbox before agreeing a mobile visit. Collect the full service address only when necessary through an agreed private process.

Only Wiper Blade Replacement is automatic-eligible under the existing rules, and its saved eligibility is unchanged. Before enabling real automatic mobile bookings, Edward must decide how location, access and travel are checked. A service confirmation currently does not verify these facts. Restricted synthetic testing can continue without advertising real mobile availability. Keep protected staging until the mobile workflow and remaining launch checks are reviewed.
