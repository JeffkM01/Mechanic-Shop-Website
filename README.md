# Ed's Auto Shop

React/Vite customer website and an Express/MongoDB appointment API. Customers can request an available service/time and use a private emailed link to manage eligible appointments. The protected mechanic dashboard reviews requests, manages the service catalog and scheduling settings, and retains cancellation history.

The repository includes production-preparation artifacts. Their presence does **not** mean the website has been deployed, SMTP delivery has been verified, or Edward's contact details, hours, capacity, and policies have been approved.

## Local development

Use Node.js 24 LTS, npm, and a running local MongoDB server at `127.0.0.1:27017` (or explicitly configure another development database).

From the project root:

```sh
npm ci
npm ci --prefix server
```

If `server/.env` does not already exist, create it using [server/.env.example](server/.env.example), then enter private development credentials locally. Preserve an existing `.env`; never commit it or copy its values into frontend code.

Start two terminals from the project root:

```sh
# Terminal 1: Express API
npm run dev --prefix server
```

```sh
# Terminal 2: Vite frontend
npm run dev
```

Open the frontend URL Vite prints, usually `http://localhost:5173`. Its development proxy forwards `/api` to `127.0.0.1:3001`. If your terminal is already inside `server`, use `npm run dev` there instead of adding another `--prefix server`.

For local management-link tests, configure `NODE_ENV=development`, set `PUBLIC_WEBSITE_ORIGIN` to the **exact frontend origin**, and provide the management secret and all existing SMTP fields. An origin of `http://localhost:5173` is different from `http://127.0.0.1:5173`. Creating a new appointment while secure issuance is disabled does not backfill a management grant later. Use synthetic customers and an approved test inbox/transport.

## Validation

With local MongoDB running, execute from the root:

```sh
npm run lint
npm run build
npm test
npm test --prefix server
npm run test:browser
```

Install Playwright's Chromium once if the test runner reports that the browser is missing:

```sh
npx playwright install chromium
```

To explore the service-catalog browser checks interactively:

```sh
npm run test:browser -- tests/service-catalog.spec.js --project=desktop --ui
```

Tests use synthetic data, injected or disabled mailers, and guarded random MongoDB databases. Do not point `TEST_MONGODB_URI` at the normal shop database or a production cluster. GitHub Actions runs these checks with a disposable MongoDB service and no production secrets; it does not deploy the website. Dependency audit findings are separate from test failures. Review proposed updates rather than running `npm audit fix --force` blindly.

CI also builds and starts the portable production image against its disposable database, checking health, frontend/API routing, and shutdown without publishing it.

## Production preparation

Follow [the production launch guide](docs/production-launch.md). The portable Docker image builds the frontend and runs the existing Node API as one non-root process, with optional same-origin serving of `dist`. Frontend-only hosting requires a separate running API and correct `/api` forwarding. Vite's development proxy is not production configuration.

The current staff sessions and email dispatcher are process-local. Use one API process/replica; a restart safely requires staff to sign in again. MongoDB persists appointments, customer-management sessions, scheduling settings, reservations, and notification intent. Do not use the unchanged backend as an autoscaled/serverless function or start several dispatchers.

Automatic booking remains disabled by default. Only eligible Wiper Blade Replacement may be confirmed automatically after Edward explicitly verifies the hours and capacity and enables the feature. All other services require mechanic approval. Deployment must not silently change those business settings.

## Further documentation

- [Scheduling, capacity, and reservation safety](docs/scheduling.md)
- [Saved service catalog and approval rules](docs/service-catalog.md)
- [Customer management, cancellation, and email semantics](docs/customer-appointment-management.md)
- [Accessibility and validation](docs/accessibility-validation.md)
- [Production launch and verification](docs/production-launch.md)
- [Backup and restore operations](docs/backup-and-restore.md)
