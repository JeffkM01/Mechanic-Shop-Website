# Service catalog and availability review

`shared/services.js` is the common catalog for service cards, appointment options, frontend validation, and the API's accepted service names. Home featured cards also look up these definitions. `Other / Not Sure` is an appointment-only option, not a public service card.

## Edward's review before deployment

The new **Tire Rotation**, **Cabin Air Filter Replacement**, and **Wiper Blade Replacement** entries are explicitly provisional. They are labeled as unconfirmed in the cards and dropdown; selecting one shows an availability warning on the request form and review. These are requests for review, not promises that Edward provides those services. No prices have been added.

Confirm whether Edward offers each service, any vehicle or equipment limitations, and the descriptions before publishing an established offering. After that confirmation, update its catalog metadata deliberately. This change does not merge, deploy, or change availability automatically. All requests still start pending and require the mechanic's approval.

**Engine Air Filter Replacement** is the clearer name for the existing engine-filter service previously called **Air Filter Change**. Review that wording with Edward as well. Old clients may still submit `Air Filter Change`; frontend/API validation accept it and storage, dashboard display, and email templates retain the exact saved name. There is no database migration or rewrite. A legacy booking URL preselects the current engine-filter option for a new request.

## Links and validation

Use `getAppointmentLink(service.name)` for service-specific links. It encodes a `service` query parameter; `getServiceSelection(search)` accepts catalog values, maps the legacy filter label, and ignores unknown values. The dropdown is grouped into Basic Maintenance and Repairs & Diagnostics. A change of linked service, including browser Back/Forward between selections, starts a matching form and clears the previous service's review.

Run these from the repository root:

```sh
node --test shared/services.test.js src/utils/appointmentValidation.test.js
npm test --prefix server
npm run build
```

Browser checks should cover all eight public cards, every preselected dropdown value, malformed/legacy links, provisional warnings, category anchors from Home and Services, responsive layouts, and a real pending submission. Keep SMTP disabled for synthetic local checks. Do not send test notifications to customers.
