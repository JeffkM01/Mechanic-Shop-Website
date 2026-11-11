# Service catalog and approval rules

The saved shop catalog lives in `SchedulingState.settings.serviceCatalog`, alongside service booking estimates and the existing reservation coordinator. `shared/services.js` supplies the initial definitions and pure lookup/approval helpers; `shared/serviceCatalog.js` validates catalog edits. Customer pages read the saved active catalog through `GET /api/services`, rather than maintaining separate lists for cards, booking selections, and API validation.

## Confirmed scope

Edward requested dashboard service editing while keeping the current services available. Removing Oil Change and adding Suspension Repair were examples of edits he should be able to make, not instructions to change the initial offerings. This release does not deactivate Oil Change or automatically add Suspension Repair.

Wiper Blade Replacement is the only service currently approved for automatic-booking eligibility. Its initial definition is no longer provisional. Oil Change and Cabin Air Filter Replacement require mechanic approval. All Repairs & Diagnostics services, including any Suspension Repair service Edward later adds, require approval. Other maintenance services remain manual until a separate business-policy change is deliberately implemented; adding a maintenance entry or changing its category cannot bypass the Wiper-only rule.

Automatic eligibility does not itself confirm an appointment. Global automation remains disabled by default. The backend also requires explicitly enabled automation, verified operating hours and capacity, an active non-provisional Wiper Blade Replacement service, an available atomically reserved slot, and an available daily automatic-admission place. Edward can require manual approval for wipers as well. Public pages display the status actually saved by the backend.

Tire Rotation and Cabin Air Filter Replacement retain their provisional availability labels. Provisional entries are requests for review, not promises that Edward provides the service for every vehicle. Confirm actual offerings, vehicle/equipment limitations, descriptions, and booking estimates before deployment.

## Staff workflow

Sign in at `/mechanic`, open **Booking Settings**, and use the service-catalog editor to add services or activate/deactivate existing entries. Adding a service requires its name, category, customer-facing description, and estimated duration, together with an explicit acknowledgment that the shop offers it. New services require mechanic approval. A booking estimate reserves scheduling time; it is not a guaranteed completion time or a billable-hour calculation.

Service changes remain drafts until the existing **Save Changes** review and **Confirm Changes** flow completes. Review shows catalog and estimate changes before writing. **Keep Editing** returns to the draft, and **Discard Changes** restores the saved configuration. A stale settings revision requires reloading the latest configuration and reviewing overlapping edits before saving again. Uncertain writes must be resolved by loading the saved state rather than blindly replaying the mutation.

The existing authenticated, CSRF-protected settings endpoint persists `{revision, settings: partialPatch}`. Catalog edits and appointment admissions use the same MongoDB compare-and-swap coordinator. A booking racing deactivation cannot use a stale availability result to bypass the final authoritative catalog check. No direct database edits, service-deletion jobs, or separate catalog collection are required.

## Deactivation and historical compatibility

Deactivate a service to stop offering it for new requests; do not delete or rename its identity. Inactive entries remain in protected settings with their scheduling rules so existing appointments remain readable, reviewable, and cancellable. Deactivation does not cancel an existing request, release its reservation, rewrite its saved service name, or change its duration/buffer snapshot. A mechanic may still review an existing request using the retained definition and original scheduling metadata, subject to the current conflict, working-hours, and timezone checks.

Service names and historical aliases are immutable once saved. Names are limited to 50 characters; names with dots, dollar signs, control characters, or reserved prototype keys are rejected because names also identify scheduling-rule paths. Names and aliases must be unique without regard to case, including inactive entries. New services cannot claim historical aliases. The catalog is bounded at 50 entries, including inactive services, and descriptions are limited to 300 characters. These bounds supplement the API's existing request-size limit.

**Engine Air Filter Replacement** retains the historical **Air Filter Change** alias. Old records and emails keep the exact service string originally saved. A legacy booking URL preselects the canonical engine-filter option only while that service is active. No appointment migration or token backfill is performed.

Existing scheduling documents without a saved catalog receive the shared initial catalog through the existing revision-guarded compatibility path. Saved hours, capacity, buffers, notice periods, existing estimates, appointments, and automation/verification flags are preserved. Approval flags that conflict with the current manual-only policy are corrected through the same coordinator. The initialization is not an instruction to replace an already edited catalog with defaults.

## Public catalog and booking validation

`GET /api/services` returns the active service definitions and settings revision, with `Cache-Control: no-store`. It exposes only catalog metadata; no customer information, appointment identifiers, reservation internals, blocked-time reasons, or management credentials are included. `Other / Not Sure` remains an appointment-only choice and does not become a public service card.

Home featured cards, Services cards, and the Appointment dropdown use the current catalog. Custom entries appear in their chosen category and support encoded `/appointment?service=...` preselection. Deactivated entries disappear from new-booking choices and public cards, including Home's featured offerings. A failed catalog read displays a retry/contact state rather than silently advertising a bundled stale catalog. The backend remains authoritative even when a browser has an old catalog or calendar result.

Run the Express API alongside Vite during development. In production, the public host must forward `/api` to the running API; the Vite development proxy does not configure production hosting. Deploying only static frontend files cannot provide the saved catalog or appointment APIs. Catalog failures intentionally show the retry/contact state until API access is restored.

`getAppointmentLink(name, catalog)` encodes a valid active definition. `getServiceSelection(search, catalog)` maps recognized historical aliases and rejects unknown or inactive choices. Frontend field validation accepts the same supplied catalog. The public booking endpoint copies only allowed customer fields; final catalog activity, duration, approval policy, and availability are checked inside the scheduling mutation against the latest state.

## Stacking and pricing remain separate proposals

Edward mentioned three oil-change customers in the same appointment hour. This is not enabled by this release. Three simultaneous occupied intervals require a different capacity decision from three sequential jobs per hour or three arrivals waiting in a drop-off queue. Confirm mechanics, bays, actual hands-on time, overlapping work, arrival expectations, and buffer/start-grid requirements before implementing that business model. Existing capacity, working hours, start increments, buffers, booking notice, and horizon are not changed by service editing.

The reported `$50/hour` labor rate and approximately `$50` oil cost do not establish a universal `$100` oil-change price. That total assumes one billable labor hour or a $50 minimum/flat labor charge, and material quantities, filters, vehicle requirements, and applicable taxes still need confirmation. Booking duration is not automatically billed labor time. No public prices or Valvoline price comparisons are introduced.

## Verification

Run the complete regression commands from the repository root:

```sh
npm test
npm test --prefix server
npm run lint
npm run build
npm run test:browser
```

Use synthetic customers, isolated MongoDB databases, and disabled or injected email transports. Do not send live notifications during automated checks. Exact passing counts and failures belong in the pull request after the final run.

Manual checks should cover adding an owner-confirmed custom service, description and duration validation, activation/deactivation/reactivation, Save/Keep Editing/Discard, stale-revision recovery, and private-state clearing on logout or expiry. Verify the new entry across Services, Home where relevant, booking dropdown/preselection, and the mechanic dashboard. Preserve historical `Air Filter Change` records and verify that deactivating a booked service does not delete or silently cancel it. Check failed catalog reads, stale booking submissions, public-response privacy, mobile layouts, keyboard controls, and zoom. Automatic-booking tests may enable verified settings only in isolated fixtures; production flags and real appointments remain unchanged.
