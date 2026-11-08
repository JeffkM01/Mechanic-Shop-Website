# Readability, booking validation, and decline communication

A real visitor reported needing to zoom a laptop to read the website. Testing also found that a phone field containing letters produced an unclear booking failure, and that a generic decline did not explain the shop's decision. Prompt 5 addresses those problems while preserving the customer calendar, scheduling settings, atomic reservations, session expiry, CSRF protection, and notification queues.

## Readability and responsive behavior

The navy, orange, white, and neutral visual identity is retained. Reusable typography tokens in `src/index.css` establish body text around 16–18 CSS pixels, readable 15–16-pixel labels, inputs/buttons of at least 16 pixels, 14–16-pixel supporting text, and important notices of at least 16 pixels. Spacing, line height, wrapping, and paragraph measure support the larger text rather than shrinking it again in mobile rules. Small decorative headings retain a distinct hierarchy without carrying essential instructions in tiny text.

Customer pages, navigation/footer, booking/calendar/review/success screens, mechanic sign-in, appointment cards, and scheduling editors are included. Available, selected, unavailable, error, and appointment-status information uses labels or symbols as well as color. Focus remains visible and the viewport does not disable user zoom. Interactive targets aim for 44×44 CSS pixels where practical; a seven-column calendar at 320 pixels must retain usable day spacing without making the page wider than its viewport.

Validation covers 320, 390, 768, 1280, 1440, and 1920-pixel widths, plus 200% text resizing and actual Chromium page zoom at 100%, 200%, and 400% for representative customer and staff reflow checks. Automated contrast/accessibility checks and screenshots complement hands-on inspection. Passing those checks is not a claim that every WCAG 2.2 AA criterion or every real user's readability needs have been verified.

## U.S. phone-number policy

`shared/appointmentFields.js` is the common frontend/backend validation source. It accepts ten national digits with separators only at the three/three/four-digit boundaries, balanced parentheses around the area code, and an optional leading `+1` or `1`. A plain eleven-digit value beginning with `1` remains accepted for compatibility. The server keeps the customer's accepted formatting, trimming only outer whitespace; it does not transform an unsupported value into a different number.

Examples accepted:

- `6365551234`
- `636-555-1234`
- `(636) 555-1234`
- `636 555 1234`
- `+1 636-555-1234`
- `16365551234`

Letters, extensions, other country codes, misplaced prefixes, unmatched parentheses, unsupported punctuation/control characters, too few digits, and arbitrary extra digits are rejected. For example, `636-55A-1234` and `636ABC5551234` cannot become valid by stripping their letters. The policy checks syntax and length; it does not verify that a number exists, belongs to the customer, or can receive calls/texts. Synthetic test numbers need not be real telephone numbers.

The phone control remains `type="tel"` with telephone autocomplete. HTML input type alone is not treated as a validation boundary.

## Email-address policy and historical recipients

The same shared validator accepts one conventional, unquoted ASCII email mailbox: a local part of at most 64 characters, a dotted DNS-style domain with labels of at most 63 characters, and an overall address limit of 254 characters. Plus tags and conventional dot-atom characters remain supported, including synthetic `.invalid` test domains. Display names, comma/semicolon recipient lists, misplaced punctuation, raw control characters, quoted local parts, and Unicode local addresses are unsupported and receive the inline email error. This checks syntax only, not ownership or deliverability; it does not send a verification email.

`buildEmail` also validates stored customer addresses before using them as a customer `To` address or mechanic-notice `Reply-To`. This protects older records created before the stricter booking validator: Nodemailer must not interpret a malformed stored value as multiple recipients or header content. Invalid historical addresses are not silently rewritten or sent. The existing queue remains pending and reports a generic address-review error without logging the address or customer-facing reason; the saved appointment decision is unchanged. Valid historical single-mailbox values continue working. Trusted configured sender/shop inbox values keep their existing configuration contract, including a legitimate display name in `MAIL_FROM`.

## Inline booking validation

The common validator reports every invalid field: full name, email, phone, vehicle, service, date, time, and optional notes. It retains the existing limits: name 80, email 254, phone 24, vehicle 120, service 50, date 10, time 5, and notes 1,000 characters. Internal dates remain `YYYY-MM-DD` and clock values remain `HH:MM`. The scheduling-authoritative mode leaves business days, notice, horizon, actual availability, and reservation admission to the existing backend.

Field-level feedback appears after blur or an attempted review/submission. Correcting a previously invalid value clears its error without clearing other entries. Each message is associated with its control using `aria-describedby`; invalid controls use `aria-invalid` and a visible indicator. An unsuccessful review identifies all affected fields and moves focus to the first invalid field or its linked error summary. Keystrokes do not trigger a separate intrusive alert for every character.

Review requires valid fields and a freshly available server-provided slot. Sending requires the customer's explicit confirmation and another fresh availability check. Client validation never replaces `prepareAppointment` and server scheduling validation. An HTTP 400 can include `{error, fields}` so a safe field-specific message appears beside its input; non-field failures remain at form level. No customer details, password, session cookie, or CSRF token are written to localStorage.

A 409 slot conflict keeps contact, vehicle, and note values, clears the conflicting time/review, and refreshes availability. A request whose network/server outcome is uncertain must not be blindly posted again: the interface retains the details, explains that the write could not be verified, and offers safe availability/contact next steps. There is no public appointment lookup, customer account, or new rescheduling/cancellation workflow in this change.

## Reviewed decline decisions

Selecting **Decline Appointment** opens a review form rather than changing status immediately. Edward chooses a category, optionally adds a customer-facing explanation for a predefined category, or supplies a required explanation for **Other**. The preview shows the exact final reason and next steps. Cancel/Back leaves the request pending; only **Confirm Decline** sends the authenticated mutation.

The shared `shared/declineReasons.js` catalog defines the categories and customer wording:

| Category | Meaning |
| --- | --- |
| `service_not_offered` | The requested service is not offered by the shop. |
| `outside_capabilities` | The vehicle or repair is outside the shop's capabilities. |
| `unable_to_accommodate` | The shop cannot accommodate the service request; the customer can discuss their vehicle's needs. |
| `parts_unavailable` | Necessary parts cannot be obtained and the requested service cannot reasonably be performed. |
| `other` | A specific customer-facing explanation is required. |

An additional explanation, when supplied, must contain 10–1,000 trimmed characters. Other requires the same meaningful minimum. Unsupported control characters and unknown fields/categories are rejected. Predefined wording plus optional extra text forms one final message of at most 1,200 characters; the email sends that saved final message rather than recalculating it later.

The protected existing endpoint accepts:

```json
{
  "status": "declined",
  "decline": {
    "category": "parts_unavailable",
    "explanation": "We cannot obtain the required replacement part to perform this service."
  }
}
```

The appointment stores `decline.category`, the final `decline.explanation`, `decline.declinedAt` as a UTC timestamp, and `decline.source: "mechanic"`. The source records the authenticated staff workflow; the existing shared-password system is not represented as a new individually identified staff account.

### A decline is not a scheduling conflict or a proposed change

A decline means the shop cannot fulfill the service request. A scheduling conflict means its original time cannot currently be approved; that request stays pending and its conflict message does not claim Edward declined it. A need to discuss another date, order parts, or ask for more information is not a promise that a replacement slot has been offered or reserved.

There is deliberately no routine "requested time unavailable" decline category, no automatic switch to another time, no silent cancellation, and no nonfunctional reschedule button. Edward can contact the customer through the existing contact details. Customer-facing next steps direct replies to the configured shop notification inbox. Public website phone/address/email placeholders are not presented as confirmed contact information.

### Persistence, authorization, and reservation ordering

Only the existing authenticated, CSRF-protected mechanic API can record a new decline. It validates the category and explanation even if the UI is bypassed. The `pending`, `confirmed`, and `declined` statuses keep their existing meanings.

A conditional appointment update saves terminal declined status, the validated final reason, timestamp/source, and the existing customer-decision queue flag together. An already confirmed or declined record cannot be declined by this pending-review action. Repeated/delayed operations cannot replace the saved reason, resurrect a declined request as confirmed, or create a new independent decision event.

The existing safe release ordering remains: persist the terminal appointment decision before removing only that appointment's reservation. An interrupted release does not turn the decision back into pending; existing reservation reconciliation recognizes terminal declined records. No historical appointment is deleted, and old declined records without reason metadata remain readable with an explicit "reason not recorded" fallback.

## Customer email formatting and delivery

All appointment email dates use `MM/DD/YYYY`, and times use AM/PM through the same pure formatting helpers as the website. Timestamp formatting uses the appointment's recorded shop timezone, including hold expiry. Historical records without a recorded timezone retain the existing America/Chicago fallback; no display conversion rewrites stored dates, times, or snapshots.

A decline email uses the fixed subject **Update on Your Appointment Request — Ed’s Auto Shop**. It includes the requested service, original date/time and timezone, saved customer-facing explanation, reference/customer/vehicle details, and shared next-step wording. It does not expose internal category codes or scheduling errors. A legacy declined record without a reason says the reason was not recorded rather than inventing one.

Customer notification replies use the already configured `MECHANIC_NOTIFICATION_EMAIL` as `Reply-To`, so a sender address need not be assumed to be a monitored inbox. No phone number, public contact address, or business capability is invented. Staff-entered explanations are included only in a plain-text body; fixed subjects and configured recipients/headers prevent that text from becoming HTML or additional recipient headers.

The MongoDB queue and retry dispatcher remain in use. A new decline suppresses only a still-unsent customer request receipt in the same terminal update; already-sent receipts and the mechanic notice are preserved. The dispatcher also reconciles older declined queues so they cannot send a false “still pending” receipt. A delayed mechanic notice reflects an already reviewed status instead of asking for another approval. A request receipt that is first sent after manual confirmation remains a receipt and points to the separate decision email, rather than falsely claiming the request is still pending or creating another confirmation. A receipt already in flight cannot be recalled and may finish before the later decision email. A transport failure leaves the decision pending for a later sweep and cannot undo a saved decline. After a message is marked sent, ordinary queue sweeps do not create another decision event. Provider acceptance followed by failed acknowledgement can still produce at-least-once SMTP delivery; this work does not claim exactly-once external email delivery or redesign the dispatcher for multiple simultaneous API processes. Tests inject a synthetic transport and never contact SMTP/Brevo or send real customer emails.

## Automated validation and isolation

Run the existing commands:

```sh
npm test
npm test --prefix server
npm run lint
npm run build
npm run test:browser
```

Coverage extends existing shared/frontend, backend MongoDB, notification, and Playwright suites. It includes phone-format matrices, complete field errors, retained entries and focus, no POST after known client validation failures, reviewed/cancelled declines, API authorization/CSRF, bounded reasons, terminal decision integrity, safe capacity release, legacy records, email contents/retries, and preservation of customer booking and staff scheduling controls.

Browser tests use mocked APIs or generated isolated MongoDB databases, synthetic customers, and disabled/injected notifications. They never use or drop the normal shop database, modify real shop settings, enable actual automatic booking, or send real emails. Existing API/MongoDB date formats, service catalog, pending holds, atomic scheduling, session revocation, and CSRF protections remain authoritative.

The zoom test uses the normal `chrome://settings/appearance` page in a disposable Chromium profile, verifies the changed layout viewport and device-pixel ratio, and captures physical viewport screenshots through CDP. It does not alter the shared browser profile or emulate zoom with only a device scale factor. Native settings require full Chromium: the existing `/usr/bin/chromium` or `PLAYWRIGHT_CHROMIUM_EXECUTABLE` is used when available, otherwise the test requests Playwright's full `chromium` channel. Install the existing browser dependency with `npx playwright install chromium` when needed; a headless-shell-only installation is insufficient for this check.

## Final verification results

The completed Prompt 5 checks passed with zero failures and zero skipped tests:

| Command | Result |
| --- | --- |
| `npm run lint` | Clean; no errors or warnings |
| `npm run build` | Production build passed |
| `npm test` | 56 frontend/shared tests passed |
| `npm run test` | The same 56 tests passed under the explicitly requested alias |
| `npm test --prefix server` | 149 backend tests passed |
| `npm run test:browser` | 138 browser cases passed |

The browser total includes 102 existing booking/scheduling regressions and 36 new usability/decline cases. Dedicated audits covered all six requested widths and actual Chromium 100%/200%/400% page zoom, plus 200% text resizing. Automated WCAG 2.2 AA checks found no violations or horizontal overflow. A final safe-contact-URI regression also passed across all three browser projects after the validated click-to-call formatting correction; this is an additional rerun of an existing case, not three new unique cases.

Screenshots were visually inspected at laptop and narrow-mobile sizes, including the decline dialog and its customer preview, with additional physical-viewport captures for native zoom. The manual dialog check cancelled the decision and verified that its synthetic request stayed pending. All database writes belonged to isolated generated test databases and all mail transports were disabled or injected.

## Manual user-testing checklist

Use synthetic information in an isolated development/test environment. Capture outbound messages with the injected transport or a controlled local preview; do not send a real customer email during testing.

1. At 1280-pixel laptop width and 100% browser zoom, read Home, About, Contact, navigation, and footer without zooming in. Ask the original reviewer whether the text is now comfortable.
2. Read Services descriptions, provisional notices, buttons, and headings at 100% zoom and confirm the page still has a clear hierarchy.
3. Choose a service, an available date, and an AM/PM time; navigate the calendar using only the keyboard and check visible focus.
4. Enter `636-55A-1234`, leave the phone field, and verify the adjacent message clearly identifies letters as the problem and is announced with its input.
5. Correct it to `(636) 555-1234`; confirm the error clears and the name, email, vehicle, notes, and selected time remain unchanged.
6. Attempt review with several missing/invalid fields, follow the focused error/summary, correct only those fields, then review and explicitly send one valid request.
7. Read the pending/confirmed result, reference, and hold message. Confirm pending wording does not imply approval; simulate a slot conflict and an uncertain write outcome without submitting duplicate requests.
8. Repeat booking at 320- and 390-pixel mobile widths, then 768-pixel tablet width. Check input labels, error messages, calendar targets, and buttons without horizontal scrolling.
9. In the staff dashboard, cancel a decline, then confirm a specific predefined/Other reason. Read the saved card and captured customer email; verify reason, U.S. date/time/timezone, and honest next steps agree. Check a legacy declined record and a genuine scheduling conflict separately.
10. At 1280, 1440, and 1920 pixels, navigate appointment filters and all scheduling editors. Repeat representative pages at 200% text/browser zoom and high-zoom reflow (for example, a 1280-pixel desktop at 400% produces about a 320-CSS-pixel viewport). Check wrapping, labels, focus not hidden by toolbars, and that controls remain usable.

Record the browser/OS, viewport and zoom, input device, assistive technology, task, observed problem, and screenshot for any issue. Manual Firefox/Safari, screen-reader use, actual laptop viewing, and original-reviewer feedback remain necessary; automated audits and simulated viewports alone cannot prove that every person can read the site comfortably. Live Brevo delivery, real shop contact monitoring, actual business hours/capacity/service availability, and repair-duration estimates still require Edward's separate verification. Automatic booking remains disabled by default, and this work is not deployed or automatically merged.
