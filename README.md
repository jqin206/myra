# myra

Thin relay between [Photon](https://photon.codes/docs/beta) (iMessage delivery) and a [Creao](https://docs.creao.ai) outfit-planning agent.

Users text their plans to a Photon iMessage number ("Austin this Saturday — brunch at 11, hike in the afternoon, dinner downtown"). This server forwards the text — with today's date and the user's recent messages — to the Creao agent, which looks up the weather and picks outfits. The server formats the result as plain text and replies in the same iMessage thread. There is no LLM in this server.

```
iPhone ──iMessage──▶ Photon ──Socket.IO "delivery"──▶ myra ──POST run / poll──▶ Creao
                       ▲                                │
                       └──── projects.sendMessage ◀─────┘        Postgres: history, dedupe, cursor
```

## How it works

1. Connects to Photon Beta's event stream (`wss://api.photon.codes/v1/projects/<id>/events/ws`, Socket.IO) and subscribes from the last saved cursor.
2. Answers only `message.received` events that are iMessage, direct (1:1), sent by a human and received by an agent. It never starts a conversation and never answers its own messages. Non-text messages get "I can only read text right now — just type out your plans!".
3. Claims the message in `processed_messages` so it is answered exactly once, even across restarts, replays, and overlapping deploys.
4. Builds the Creao request: today's date in the user's timezone, up to 10 of the user's messages from the last 30 days, the user's saved outfits for today onward (one per date), the dates of their most recent trip, and the current message. Creao decides which dates the message is about: a date that's already planned ("make Oct 24 dressier") revises only that day; a date that isn't planned is a new itinerary; a preference with no date ("no jeans") revises every day of the most recent trip. Creao returns only the days it planned or revised, and each returned day replaces the saved outfit for that date.
5. Replies "Analyzing your input..." straight away, then starts a Creao run and polls it. The request asks for one outfit per day, with a dress or jumpsuit in `items.dress` (shown as a "👗 Dress" line). If there's no result after 3 minutes it stops waiting (Creao has no cancel API, so the run just finishes on its side and is ignored) and sends "Sorry, your request timed out. Please try again". If the message mentions a temperature unit ("use Celsius", "°F"), that preference is saved for the user and used for all later replies. A message that only sets the unit gets a short confirmation and no Creao run.
6. Formats the outfits as plain text (split after an outfit block when the reply is over ~1,200 characters). Replies use the idempotency keys `reply:<message id>`, `reply:<message id>:<n>` and `reply:<message id>:interim`.
7. Stores the message for history, marks it handled, and only then advances the Photon cursor.

Messages from different conversations are handled in parallel. Messages from the same conversation are handled one at a time, in order. The cursor only moves past an event once that event and every earlier one are done, so a crash replays events and never skips them.

## Environment variables

| Name | Required | Description |
| --- | --- | --- |
| `PHOTON_API_KEY` | yes | Photon Beta project API key. |
| `PHOTON_PROJECT_ID` | yes | `pho_prj_…` project ID. |
| `PHOTON_AGENT_HANDLE` | no | **Local testing only.** If set, only messages received by this handle (e.g. `+15551234567`) are answered. Leave unset in deployed environments. |
| `CREAO_API_KEY` | yes | Either an app-scoped API Trigger key (`capi_…`) or a CREAO CLI account key (`cr_sk_…`). The prefix selects the endpoint (see below). |
| `CREAO_AGENT_ID` | yes | Creao agent/app ID. |
| `DATABASE_URL` | yes | Postgres connection string. TLS is verified for remote hosts. localhost and `*.railway.internal` connect without TLS. Append `?sslmode=no-verify` only if you must accept an unverified certificate. |
| `DEFAULT_TIMEZONE` | no | IANA timezone for users without one. Default `America/Los_Angeles`. |
| `DEFAULT_TEMP_UNIT` | no | `fahrenheit` or `celsius`, used until a user states a preference. Default `fahrenheit`. |
| `PORT` | no | Port for `GET /health`. Default `8080` (Railway sets it). |
| `PHOTON_API_ORIGIN` | no | Default `https://api.photon.codes`. |
| `CREAO_TIMEOUT_MS` | no | How long to wait for Creao before cancelling the run and sending the timeout reply. Default `180000` (3 min). |
| `RAILWAY_TOKEN` | deploy only | Used by the Railway CLI, not by the server. |

Secrets are only read from the environment. Logs contain IDs and statuses, never message text or keys.

### Creao key types

| Key prefix | Endpoint | Body |
| --- | --- | --- |
| `capi_` (API Trigger, app-scoped) | `POST https://agent.creao.ai/api/v1/apps/{CREAO_AGENT_ID}/runs`, poll `GET …/runs/{id}` | `{ "inputs": { "request", "temp_unit" } }` |
| `cr_sk_` (CREAO CLI) | `POST https://developer.creao.ai/v1/runs`, poll `GET /v1/runs/{run_id}` | `{ "agent_id", "input": { "request", "temp_unit" } }` |

With the Fashion Stylist agent, `result.text` only holds a short summary. The full outfit plan is an `outfits.json` artifact on the run, which the server downloads. Bare outfit objects and the older `{ run_id, conversation_id, status, result }` wrapper are accepted too.

## Local development

Requires Node.js 24+ and Postgres.

```sh
npm ci
docker run -d --name myra-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=myra -p 5432:5432 postgres:16
cp .env.example .env   # fill in the keys
set -a; source .env; set +a
npm run dev            # runs migrations, connects to Photon, serves /health
```

Checks:

```sh
npm run typecheck
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/myra npm test
```

The dedupe/idempotency integration tests are skipped if `TEST_DATABASE_URL` is not set.

### Pointing the agent at a test phone

Based on Photon Beta's [Build an iMessage agent](https://photon.codes/docs/beta/get-started/imessage) guide:

1. In the Photon dashboard, select the project and open **iMessage**. Under **Add the number you or your user will send from**, enter the iMessage phone number (or Apple-account email) of your test phone. Then **Assign a number from the shared pool**. The assigned number is the agent's number. Only messages from the assigned sender reach this line.
2. Optionally set `PHOTON_AGENT_HANDLE` to the agent's number for local runs, so a local run only answers that line.
3. Start the server, then text the agent's number from the test phone, e.g. "Austin this Saturday — brunch at 11, hike in the afternoon, dinner downtown". You have to send first: the agent never starts a conversation.
4. Stop any other consumer of the same project first (e.g. staging). Every consumer would answer, and they would also share or fight over the same replay cursor.

Photon replays events from the saved cursor. A fresh database starts at cursor `0`, so the first run may see older events that are still retained. The `processed_messages` table stops repeat replies, but to be safe, start local runs against a database that shares state with the deployment, or against a project with no recent traffic.

## Deploying (Railway)

`railway.json` sets up one always-on service: it builds with `npm ci && npm run build`, starts with `npm start` (migrations run on startup), health-checks `/health`, runs a single replica, and restarts on failure.

```sh
railway link                  # select the project and the *staging* environment
railway add --database postgres   # if the environment has no Postgres yet
railway variables --set PHOTON_API_KEY=… --set PHOTON_PROJECT_ID=… \
  --set CREAO_API_KEY=… --set CREAO_AGENT_ID=… \
  --set 'DATABASE_URL=${{Postgres.DATABASE_URL}}'
railway up --environment staging
```

Deploy to staging first. Production deploys happen after PR review.

## Data model

| Table | Purpose |
| --- | --- |
| `messages` | User messages (history for Creao). Rows older than 30 days are deleted every 6 h. |
| `processed_messages` | One row per Photon message: `processing` → `replied`. Used to answer each message exactly once. |
| `users` | One row per conversation: handle, optional timezone / temp unit overrides. |
| `event_cursor` | Last Photon `seq` fully handled. Only moves forward. |
| `creao_runs` | Creao run ID, thread ID, status, latency per message, and the plan sent when it was a new trip (its dates are the "most recent trip" for 7 days; cleared after 30 days). |
| `planned_days` | The latest outfit, location and weather per user per date, so a later message mentioning that date revises it (deleted 30 days after the date). |
