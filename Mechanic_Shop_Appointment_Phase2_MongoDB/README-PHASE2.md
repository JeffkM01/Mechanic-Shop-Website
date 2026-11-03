# Mechanic Shop Website — Phase 2: MongoDB Appointment Requests

This package builds on the **working Phase 1 form** in https://github.com/JeffkM01/Mechanic-Shop-Website.
It saves customer appointment requests to MongoDB through an Express API. It does **not** send emails or grant mechanic approval yet.

## 1. Add files to your existing project

Unzip this package **inside the root** of your existing `Mechanic-Shop-Website` folder.
Keep your original project files. Merge the `src` directory and replace the supplied `src/pages/Appointment.jsx`, `src/styles/Appointment.css`, `vite.config.js`, and `.gitignore` files. `server` is a new folder.

Recommended before copying:

```bash
git switch -c feature/appointment-mongodb-phase2
```

Do not delete `src`, `package.json`, or your existing pages.

## 2. Create a MongoDB database (Atlas is free to start)

You do **not** need to install PostgreSQL or MongoDB locally if you use Atlas.

1. Visit https://www.mongodb.com/cloud/atlas/register, create an Atlas account, and create an **M0 Free** cluster.
2. Create a **database user** and password (separate from your Atlas login).
3. Under **Network Access**, add **your current IP address**, not `0.0.0.0/0` (allow all).
4. On the cluster, select **Connect → Drivers → Node.js** and copy the connection URI.
5. Replace the username and password in the URI with your **database user** credentials, and set the database name to `mechanic_shop` (before the `?`). URL-encode special characters in the password.

Your database/collection will be created automatically when you successfully submit the first request.

## 3. Set up the backend

Open the project folder in VS Code. From the project root:

```bash
cd server
npm install
```

Copy `server/.env.example` to `server/.env` (in PowerShell use `Copy-Item .env.example .env`; in Bash use `cp .env.example .env`). Open `.env` and paste the **real** Atlas connection string:

```
MONGODB_URI=mongodb+srv://YOUR_DATABASE_USER:YOUR_PASSWORD@YOUR_CLUSTER.mongodb.net/mechanic_shop?retryWrites=true&w=majority
PORT=3001
```

Never paste credentials into chat, React code, or GitHub. `.env` is excluded by the included `.gitignore`.

In terminal 1:

```bash
npm run dev
```

Expected: `Appointment API listening at http://localhost:3001`.
Visit http://localhost:3001/api/health — it should display `{"database":"connected"}`.

If the connection fails, check the Atlas IP allowlist, database username/password, URI, and Internet connection.

## 4. Run the React frontend

In **a second terminal**, from the **project root** (not `/server`):

```bash
npm install
npm run dev
```

Open Vite's local URL and visit `/appointment`.

The new `vite.config.js` proxies `/api` from the browser to the Express server at `127.0.0.1:3001`.
You must keep **both** terminals running during local development.

## 5. Verify Phase 2

1. Submit valid appointment details and click **Review Appointment Request**.
2. Click **Send Appointment Request**.
3. You should see `Appointment request saved!`, status `pending`, and a reference ID.
4. In MongoDB Atlas, go to **Browse Collections / Data Explorer**. Look for database `mechanic_shop` and collection `appointments`.
5. Confirm that the saved document has the correct fields and `status: "pending"`.
6. Try a Sunday or a past date. The server will refuse it even if someone bypasses the browser checks.

Run validation tests from the project root:

```bash
node --test src/utils/appointmentValidation.test.js server/appointmentInput.test.js
```

## What this phase does / does not do

**Works:** React form → review → HTTP POST → Express validation → MongoDB → pending reference ID.

**Not yet built:** Mechanic dashboard, approval/decline flow, customer or mechanic emails/SMS, authentication, rate limiting, and production deployment.

**Security:** Only POST is public; the API does not expose an unauthenticated endpoint for reading customer appointments. The local API listens on `127.0.0.1` and is for development only. Do not deploy this publicly or use it for real customer data until authentication, abuse protection, privacy considerations, and notifications are in place.

**Shop time zone:** The server checks dates in `America/Chicago`; dates and times are stored as shop-local strings.

## Files included

- `src/pages/Appointment.jsx` — two-step review and actual POST to `/api/appointments`
- `src/styles/Appointment.css` — form/review/success styles
- `src/utils/appointmentValidation.js` and `.test.js` — your Phase 1 validation (unchanged)
- `server/appointmentInput.js` — server-side validation + safe field selection
- `server/Appointment.js` — MongoDB schema
- `server/index.js` — Express endpoints and MongoDB connection
- `server/package.json` and `.env.example` — dependencies and configuration
- `server/appointmentInput.test.js` — validation tests
- `vite.config.js` — local API proxy
- `.gitignore` — protects `.env` credentials

## After testing

```bash
git status
git add src server vite.config.js .gitignore
git commit -m "Phase 2: save appointment requests to MongoDB"
```

`server/.env` should NOT appear in the changes to commit.
