# Mechanic Shop Website — Appointment Form, Phase 1

This package is a small update for the existing repository: https://github.com/JeffkM01/Mechanic-Shop-Website

## Install the changes

Copy the `src` directory from this package into the ROOT of your existing Mechanic-Shop-Website folder, allowing it to replace `src/pages/Appointment.jsx`. The other three files are new. Keep the rest of your repository unchanged.

Alternatively, from the repo root, extract the ZIP here (back up any local changes to Appointment.jsx first).

## Try it

```
npm install
npm run dev
```

Open the local URL printed by Vite and visit `/appointment`.

1. Fill out the appointment form.
2. Try a past date, a Sunday, and an invalid phone number to test validation.
3. Submit valid values to see a review summary.

Optional validation tests (Node.js 20+):

```
node --test src/utils/appointmentValidation.test.js
```

## Honest limitations

This phase validates form data and displays a local preview **only**. It does not save appointment requests to a shared database, send emails, or notify the mechanic. That requires a backend and an email service in Phase 2. Do not use this version for real customer appointment bookings.

## Files

- `src/pages/Appointment.jsx` — replaced form component
- `src/styles/Appointment.css` — new responsive form styles
- `src/utils/appointmentValidation.js` — date, contact and required-field validation
- `src/utils/appointmentValidation.test.js` — runnable unit tests
