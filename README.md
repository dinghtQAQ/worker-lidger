# worker-lidger

Personal income and expense ledger API for Cloudflare Workers and D1.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/dinghtQAQ/worker-lidger)

The deploy flow creates the Worker and D1 database, asks for the private
`WORKER_API_TOKEN`, applies remote D1 migrations, and then deploys the Worker.
The repository contains only deploy-button defaults; Cloudflare replaces the
D1 resource ID during provisioning.

## Local Cloudflare development

Requires Node.js 22 or later and a Cloudflare account for remote operations.

```sh
npm install
cp .dev.vars.example .dev.vars
npm run db:migrations:local
npm run dev
```

Replace the placeholder in `.dev.vars` with a long random token. Wrangler reads
that file only for local development; it is ignored by Git.

Run both the Python reference tests and the Worker tests with:

```sh
npm test
```

## Deploy

The button above is the one-click path for this public repository. For a manual
deployment, authenticate Wrangler, create the production secret, and deploy:

```sh
npx wrangler login
npx wrangler d1 create worker-lidger-db
npx wrangler secret put WORKER_API_TOKEN
npm run deploy
```

For a manual deployment, replace the all-zero `database_id` in
`wrangler.jsonc` with the ID returned by `wrangler d1 create`. Keep that
deployment-specific value local and do not commit it. One-click deployment
performs this D1 provisioning and configuration automatically.

`npm run deploy` runs `wrangler d1 migrations apply DB --remote` before
`wrangler deploy`. The command targets the `DB` binding so it also works when a
deployer chooses a different database name. Never commit `.dev.vars`, real
tokens, Cloudflare account IDs, or provisioned database IDs.

## API

`GET /healthz` is public. All `/v1/*` routes require:

```http
Authorization: Bearer <WORKER_API_TOKEN>
Content-Type: application/json
```

The API provides category CRUD at `/v1/categories`, ledger entry CRUD at
`/v1/entries`, installment status at `/v1/installments/{id}`, and monthly views
at `/v1/months/{month}` where `month` is `YYYY-MM`.

Monetary fields such as `amount_minor` are integers in the currency's minor
unit, never binary floating-point values. For CNY, `amount_minor` is fen, so
`1234` represents CNY 12.34.

Deleting categories deactivates them and deleting ledger entries voids them,
preserving an auditable financial history.

## Python reference backend

The standard-library Python server remains available as a local/reference
backend. Configure it with `.env.example`, then run:

```sh
python3 -m worker
```

Cloudflare deployments use `src/index.mjs` and D1 migrations from
`migrations/`; they do not run the Python server.

## iPhone Shortcut

The signed, importable shortcut is
[`shortcuts/worker-lidger.shortcut`](shortcuts/worker-lidger.shortcut). Send it
to an iPhone with AirDrop or iCloud Drive, open it in Shortcuts, and answer the
two setup questions:

1. Enter the deployed Worker's HTTPS URL without a trailing slash, for example
   `https://ledger.example.com`.
2. Enter the same private token configured as `WORKER_API_TOKEN` on the Worker.

The values in the repository are placeholders. The token is used only to form
the `Authorization: Bearer <token>` request header; the shortcut never shows it
in a result or includes it in a URL. If setup questions are not shown by an
older iOS release, edit the first two configurable Text actions immediately
after import and replace `https://YOUR-WORKER.example.com` and
`PASTE_BEARER_TOKEN_HERE`.

At runtime, choose income or expense, a live top-level category, an optional
matching child category (`无细项` skips it), and a positive CNY amount. Amounts
with more than two decimal places, zero, and negative values are rejected. The
shortcut uses the phone's current local date and displays either the created
entry ID or a concise API error.

The maintainable source is
[`scripts/generate-shortcut.mjs`](scripts/generate-shortcut.mjs); its generated
plist is [`shortcuts/worker-lidger.shortcut.plist`](shortcuts/worker-lidger.shortcut.plist).
On macOS, rebuild and apply Apple's `anyone` signature with:

```sh
npm run shortcut:build
npm run test:shortcut
```

`shortcut:build` requires the macOS `shortcuts` and `plutil` commands. Never
put a real deployment URL or token in the committed source before rebuilding.
