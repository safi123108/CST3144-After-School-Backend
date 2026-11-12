# CST3144 After-School App — Backend API

REST API backend for the CST3144 Full Stack Development after-school lesson booking application. Built with Node.js, Express 5, and the official native MongoDB Node.js driver (without Mongoose).

## Technology Stack

- **Runtime:** Node.js `>=20.19.0` (required by `mongodb@^7.8.0`; tested locally with Node `v24.21.0`)
- **Framework:** Express `^5.3.0` (`express.json()`, static assets, modular routers/middleware)
- **Database:** MongoDB Atlas via official `mongodb@^7.8.0` native driver (`MongoClient`, client sessions/transactions)
- **Middleware & Configuration:** `cors@^2.8.6`, `dotenv@^18.0.9`
- **Testing:** Built-in Node.js test runner (`node:test`, `node:assert/strict`) using isolated in-memory mocks

## Architecture & Project Structure

```text
backend/
├── app.js                     # Express app factory with DI (db, client, corsOrigin, imagesDir) & REST routes
├── server.js                  # MongoDB connection bootstrap, PORT binding, SIGTERM/SIGINT graceful shutdown
├── seed.js                    # Idempotent database seeder ($setOnInsert / --reset) and index setup
├── package.json               # Dependencies and scripts (start, test)
├── render.yaml                # Render Blueprint template for Web Service deployment
├── .env.example               # Template for local/deployment environment variables
├── .gitignore                 # Excludes node_modules/, .env, local env files, OS artifacts
├── config/
│   └── cors.js                # Origin normalization, CORS_ORIGIN allowlist parser, OPTIONS preflight config
├── middleware/
│   └── images.js              # Static SVG serving, seeded .png -> .svg fallback, clean 404 JSON
├── services/
│   └── lessons.js             # Shared lesson retrieval & escaped multi-attribute regex/ObjectId filtering
├── public/
│   └── images/                # Backend SVG assets (hero.svg + 10 subject SVGs matching seeded .png filenames)
└── test/                      # Permanent automated node:test suite (mocked DB/client, HTTP tests)
    ├── helpers/
    │   ├── http-client.js     # Ephemeral port (0) HTTP client helper
    │   └── mock-db.js         # Stateful in-memory MongoDB & transactional session mock
    ├── app-error-handling.test.js
    ├── cors.test.js
    ├── images.test.js
    ├── lessons.test.js
    ├── orders.test.js
    ├── seed.test.js
    └── server.test.js
```

## Prerequisites & Installation

- **Node.js** `>=20.19.0` (recommended: Node 22 LTS or 24 LTS) and **npm**
- A **MongoDB Atlas** cluster (M0 free tier or replica set required for multi-document transactions)

Install dependencies inside `backend/`:

```bash
npm install
```

## Environment Setup

Copy [`.env.example`](.env.example) to `.env` in `backend/` and fill in your own MongoDB Atlas connection string:

```bash
cp .env.example .env
```

Never commit `.env` (it is ignored by [`.gitignore`](.gitignore)).

| Variable | Required | Default | Description |
| :--- | :--- | :--- | :--- |
| `PORT` | No | `3000` | HTTP listen port. Set automatically by Render in production. |
| `MONGODB_URI` | Yes | — | MongoDB Atlas connection string (`mongodb+srv://...`). Startup and `seed.js` fail fast if missing. |
| `DB_NAME` | No | `after_school_app` | Target MongoDB database name. |
| `CORS_ORIGIN` | No | *(blank / `*`)* | Comma-separated allowed browser origins (e.g. `http://127.0.0.1:5500,http://localhost:5500,https://<github-username>.github.io`). Leave blank locally for open non-credentialed `*`. |
| `NODE_ENV` | Render | `production` | Standard production environment flag in [`render.yaml`](render.yaml). |
| `NODE_VERSION` | Render | `"22"` | Ensures Render provisions a Node runtime compatible with `mongodb@^7.8.0`. |

## Local Startup

1. Configure `backend/.env` with your `MONGODB_URI` and optional `DB_NAME` / `CORS_ORIGIN`.
2. Seed initial collections and indexes (safe to re-run):
   ```bash
   node seed.js
   ```
3. Start the API server:
   ```bash
   npm start
   ```
4. Verify locally at `http://localhost:3000/api/health` (or whatever `PORT` you configured).

Press `Ctrl+C` (`SIGINT`) or send `SIGTERM` to trigger graceful HTTP + MongoDB shutdown.

## Automated Tests & Validation

Run the full test suite completely offline (no live MongoDB Atlas connection or `.env` secrets required):

```bash
npm test
```

What `npm test` runs (`node --test "test/*.test.js"`):
- App factory dependency injection, `GET /`, `GET /api/health`, JSON `400`/`404`/`500`/`503` error handling
- Server startup validation, failure cleanup, `stopServer()` idempotency, `SIGTERM`/`SIGINT` graceful shutdown
- Image static serving, seeded `.png` -> `.svg` fallback (`GET`/`HEAD`), path traversal blocking, `404` JSON
- Lesson queries, `/lessons/search` validation/escaping/attributes/`teacherId` ObjectId lookup, teachers, enrolment totals
- Order creation validation & item consolidation, `PUT /lessons/:id` updates/order confirmations/conflicts/rollbacks, transactional `DELETE /orders/:orderId` cancellations
- CORS normalization, wildcard fallback, origin allowlist matching, blocked origins, `OPTIONS` `204` preflight
- Safe `$setOnInsert` seeding, `--reset`, index deduplication, and `NamespaceNotFound` (`code: 26`) handling

Additional checks:

```bash
# Node.js syntax check across source and test files
node --check app.js
node --check server.js
node --check seed.js
node --check middleware/images.js
node --check services/lessons.js
node --check config/cors.js

# Git whitespace / conflict-marker check
git diff --check
```

## API Endpoints

All database-backed routes (`/lessons`, `/orders`, `/teachers`, `/enrolment`) return HTTP `503` JSON if MongoDB is unavailable.

| Method & Path | Purpose | Status Codes |
| :--- | :--- | :--- |
| `GET /` | Plain-text readiness banner | `200` |
| `GET /api/health` | Backend and database connectivity status JSON | `200` |
| `GET /images/:filename` | Serves `.svg` static files and resolves seeded `.png` filenames to `.svg` | `200`, `404` JSON |
| `GET /lessons` | Retrieve all lessons | `200`, `500`, `503` |
| `GET /lessons/search?q=...` | Case-insensitive multi-attribute search (`topic`, `location`, `image`, `price`, `space`, 24-hex `teacherId`). Missing/empty `q` returns all lessons; `q` > 100 chars or array returns `400`. | `200`, `400`, `500`, `503` |
| `PUT /lessons/:id` | **Generic update:** updates permitted fields (`topic`, `location`, `price`, `space`, `image`, `teacherId`), with optimistic `space` concurrency and transactional teacher `lessonIds` sync.<br>**Order confirmation:** when body contains `{ "orderId": "...", "space": <integer >= 0> }` (no extra fields), atomically compares-and-sets `lesson.space`, marks order item `confirmed: true`, and sets order `status: "confirmed"` when all active items are confirmed. | `200`, `400`, `404`, `409`, `500`, `503` |
| `POST /orders` | Validates `name` (letters/spaces), `phone` (digits only), `items` (non-empty array), consolidates duplicate `lessonId`s, verifies stock, and inserts a `pending` order (`space` is decremented later on `PUT /lessons/:id` confirmation). | `201`, `400`, `404`, `409`, `500`, `503` |
| `DELETE /orders/:orderId` | Atomically cancels unconfirmed items in a `pending` order (`status: "cancelled"`, or `"partially_cancelled"` preserving confirmed items/spaces). Rejects already confirmed or cancelled orders. | `200`, `400`, `404`, `409`, `500`, `503` |
| `GET /teachers` | Retrieve all teachers | `200`, `500`, `503` |
| `GET /teachers/:id/lessons` | Retrieve lessons belonging to a teacher (`teacher.lessonIds`) | `200`, `400`, `404`, `500`, `503` |
| `GET /enrolment/:lessonid` | Sum enrolled spaces for a lesson across confirmed (and legacy unflagged) order items | `200`, `400`, `404`, `500`, `503` |

### Request Examples

**Search lessons:**
```bash
curl "http://localhost:3000/lessons/search?q=Maths"
```

**Create a pending order (`POST /orders`):**
```bash
curl -X POST http://localhost:3000/orders \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Alex Smith",
    "phone": "07123456789",
    "items": [{ "lessonId": "<lessonObjectId>", "space": 1 }]
  }'
```

**Confirm an order item and update lesson space (`PUT /lessons/:id`):**
```bash
curl -X PUT http://localhost:3000/lessons/<lessonObjectId> \
  -H "Content-Type: application/json" \
  -d '{ "orderId": "<orderObjectId>", "space": 4 }'
```

**Cancel unconfirmed items in an order (`DELETE /orders/:orderId`):**
```bash
curl -X DELETE http://localhost:3000/orders/<orderObjectId>
```

### Health Endpoint Behavior

`GET /api/health` is mounted intentionally before the `503` database guard (`requireDb`) so monitoring probes and Render health checks receive a consistent JSON payload:

```json
{
  "success": true,
  "message": "Backend is working correctly",
  "database": {
    "connected": true,
    "name": "after_school_app"
  }
}
```

- Returns HTTP `200` with `database.connected: true` and the configured database name once connected.
- Returns `database.connected: false` and `database.name: null` if queried while no DB connection is attached (while DB-backed API routes return HTTP `503` JSON).
- During server boot (`server.js`), MongoDB connects before the HTTP port starts listening, so the port does not begin accepting live traffic until Atlas connection succeeds.

## MongoDB Collections

| Collection | Purpose | Document Fields |
| :--- | :--- | :--- |
| `lesson` | After-school classes | `_id` (`ObjectId`), `topic` (string), `location` (string), `price` (number), `space` (non-negative int), `image` (filename e.g. `maths.png`), `teacherId` (`ObjectId` -> `teacher._id`) |
| `teacher` | Instructors | `_id` (`ObjectId`), `name` (string), `lessonIds` (`ObjectId[]` -> `lesson._id`) |
| `order` | Bookings & checkout states | `_id` (`ObjectId`), `name` (string), `phone` (string), `items` (`[{ lessonId, space, confirmed, cancelled? }]`), `status` (`"pending"` \| `"confirmed"` \| `"partially_cancelled"` \| `"cancelled"`), `createdAt` (`Date`), `confirmedAt?` (`Date`), `cancelledAt?` (`Date`) |

## Seeding & Index Management (`seed.js`)

- **Safe default mode (`node seed.js`):**
  Uses `$setOnInsert` with `upsert: true` for all 3 predefined teachers and 10 predefined lessons. Missing seeded documents are inserted, while modified live spaces, updated topics/teachers, and existing `order` records remain intact across repeated executions.
- **Explicit reset mode (`node seed.js --reset`):**
  Uses `$set` with `upsert: true` to restore the 3 teachers and 10 lessons back to defaults (including `space: 5`) without deleting orders.
- **Automatic index creation (`ensureIndexes`):**
  Ensures indexes `idx_order_items_lessonId` (`order` `{ "items.lessonId": 1 }`) and `idx_teacher_lessonIds` (`teacher` `{ lessonIds: 1 }`). Handles MongoDB `NamespaceNotFound` (`code: 26`) if collections do not yet exist, and skips creating duplicate indexes when an index already matches by name or key specification.

## CORS Configuration

Handled by [`config/cors.js`](config/cors.js):

- **Default (`CORS_ORIGIN` omitted, blank, or `*`):** allows all origins (`*`) without credentials (`optionsSuccessStatus: 204`).
- **Allowlist (`CORS_ORIGIN=origin1,origin2,...`):** trims whitespace, strips trailing paths/slashes, canonicalizes HTTP(S) schemes/hosts via `URL.origin`, permits browser requests from listed origins (both local live servers and GitHub Pages), omits `Access-Control-Allow-Origin` for unlisted browser origins, allows non-browser requests with no `Origin` header (curl/Postman/Render probes), and responds to `OPTIONS` preflight with methods `GET, HEAD, POST, PUT, DELETE, OPTIONS` and headers `Content-Type, Authorization`.

## Render Deployment Steps

No live deployment has been run from this repository yet. When deploying to Render:

### Option A: Blueprint (`render.yaml`)

1. Edit [`render.yaml`](render.yaml) and replace `<student-number>` in `services[0].name` with your student ID (e.g., matching your coursework naming convention).
2. Push this standalone `backend` Git repository to GitHub (confirming `.env` is not tracked).
3. In the Render Dashboard, choose **New + -> Blueprint**, connect the backend GitHub repository, and provide real values when prompted for:
   - `MONGODB_URI` (your MongoDB Atlas SRV connection string)
   - `CORS_ORIGIN` (comma-separated origins, including your GitHub Pages frontend origin `https://<github-username>.github.io`)

### Option B: Manual Render Web Service

1. In Render, select **New + -> Web Service** and connect the backend repository.
   - If deploying from this standalone `backend/` repo, leave **Root Directory** empty; if deploying from a parent monorepo containing both `frontend` and `backend`, set **Root Directory** to `backend`.
2. Configure:
   - **Runtime:** Node (`NODE_VERSION=22` or matching `>=20.19.0`)
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Health Check Path:** `/api/health`
3. Add environment variables in Render:
   - `MONGODB_URI` = your Atlas connection string
   - `DB_NAME` = `after_school_app`
   - `CORS_ORIGIN` = your allowed origin(s), e.g. `https://<github-username>.github.io` (do not set `PORT`; Render injects `PORT` dynamically)
4. Ensure MongoDB Atlas **Network Access** allows connections from Render (or `0.0.0.0/0` per Atlas deployment guidance for dynamic Render egress IPs).
5. Seed your production Atlas database once locally against that cluster (with your `MONGODB_URI` in local `.env`): `node seed.js`.
6. Copy the live Render `https://...` URL once active into `frontend/js/config.js` (`productionApiBaseUrl`), test `/api/health` and `/lessons`, and verify CORS from GitHub Pages.

## Postman Collection & Sample Exports

- **Postman collection:** [`../postman/CST3144-Postman-Collection.json`](../postman/CST3144-Postman-Collection.json) (covers `/lessons`, `/lessons/search`, `/PUT /lessons/:id`, `/teachers`, `/teachers/:id/lessons`, `/enrolment/:lessonid`, `/orders`, `/DELETE /orders/:orderId`, and `/api/health`; defaults `baseUrl` to `http://localhost:3000`).
- **Sample database exports:** [`../database-exports/`](../database-exports/) (`lesson.json`, `teacher.json`, `order.json`).

## Known Limitations & Pending Live Verification

- **Automated tests use in-memory mocks:** `npm test` runs offline against mocked MongoDB collections/sessions and ephemeral local HTTP ports. Live MongoDB Atlas connectivity, authentication, network access rules, and `node seed.js` execution against Atlas remain to be verified against the target cluster.
- **MongoDB transaction topology requirement:** Multi-document sessions (`PUT /lessons/:id` order confirmation and teacher reassignment, `DELETE /orders/:orderId`) require a replica set or MongoDB Atlas cluster; a standalone un-replicated local `mongod` server will not support multi-document transactions.
- **Render deployment not yet performed:** After pushing to Render and updating `frontend/js/config.js`, verify live `/api/health`, `/lessons`, CORS headers against the GitHub Pages origin, checkout/cancellation rollback flows, and Render free-tier spin-up latency directly.
- **Image fallback path constraint:** [`middleware/images.js`](middleware/images.js) passes the resolved asset path directly to Express `res.sendFile()`, which under default `dotfiles: 'ignore'` rejects serving `.png` -> `.svg` fallbacks if the repository directory itself resides inside a hidden dot-prefixed folder (such as `.hidden`); standard local OS and Render deployment paths are unaffected.
