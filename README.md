# Brew Journal

A coffee and tea journal with a **dial-in assistant**. You log what you brewed and how it tasted, and the app tells you the one thing to change next time.

**Live app:** _add your deployed URL here_ · **Demo video:** _add link here_

---

## Problem statement

Home brewers make the same cup over and over without knowing why it tastes sour one day and bitter the next. The fix is usually simple (grind finer, use cooler water, steep for less time), but you have to know which lever to pull, for which drink, and you have to remember what you did last time. Tea drinkers have a second problem. Most people do not own a thermometer, yet green tea at 100 °C and at 75 °C are completely different drinks.

## Target users

- Home coffee brewers using espresso, pour-over, AeroPress, French press, moka pot or cold brew.
- Tea drinkers brewing western style (mug or teapot) or gongfu style (small pot, many infusions).
- Beginners without a scale-and-thermometer setup who still want consistent results.

## Solution

Brew Journal turns each brew into data, then runs that data through a rule-based engine that encodes standard barista and tea-brewing practice:

1. **Log** the recipe (dose, water, grind, temperature, time) and how it tasted (sour, balanced or bitter for coffee; flat, balanced, astringent or bitter for tea), plus strength and a rating.
2. **Diagnose:** the engine reads taste as under- or over-extraction and picks **one** adjustment, because changing one variable at a time is how you learn. The rules depend on the drink: a sour French press should steep longer, a sour pour-over should be ground finer, a bitter dark roast needs cooler water first, a bitter green tea needs cooler water, and a bitter black tea needs a shorter steep.
3. **Brew again:** one click opens the form pre-filled with the suggested recipe, so the loop is easy to follow.
4. **Learn from history:** the engine compares each brew with the previous one of the same item, method and infusion, and reports whether the change helped.

## Key features

| Workflow | What happens |
|---|---|
| **Accounts** | Register and log in. Every coffee, tea and brew is private to its owner. |
| **Shelf** | Add coffee beans (roast level, origin, roast date) and teas (green, white, oolong, black, pu-erh, herbal). Each coffee shows its freshness: days off roast, plus a *resting / peak / fading / stale* status. |
| **Log a brew → advice** | Validated brew form, then a suggestion page with the main change, the reasoning, alternatives, out-of-range warnings and a comparison with your last brew. |
| **Brew again** | The form opens pre-filled with the suggestion. For gongfu tea it also moves to the next infusion and adds the extra steep time. |
| **Best recipe & history** | Each item shows your highest-rated recipe and a full history table. |
| **No-thermometer temperature** | When logging, you can pick what the water looked like instead of entering a number ("shrimp eyes", "crab eyes", "string of pearls"…) and the app estimates the temperature. Every suggested temperature is also given as a bubble stage, a rest time after boiling, and a boiling-plus-cold mixing ratio. |
| **Calculator** (public) | Choose a coffee method and roast, or a tea type and style, plus a cup size. You get dose, ratio, time, grind and the three ways to reach the right temperature. |

## Tech stack

- **Node.js 22.13+ and Express 5**: an HTTP server with server-rendered pages.
- **EJS** templates and one small hand-written CSS file. No frontend framework or build step; the app works without JavaScript.
- **MongoDB** through the official `mongodb` driver. Production uses **MongoDB Atlas** (free M0 cluster). Locally, when `MONGODB_URI` is unset, an embedded `mongod` from `mongodb-memory-server` starts automatically, so `npm start` works with no setup.
- **bcryptjs** for password hashing and **cookie-session** for signed, httpOnly session cookies.
- **node:test** for unit tests and end-to-end tests (the real app against a throwaway MongoDB).

### Why these choices

- **Server-rendered pages.** The workflows are form-driven, so a SPA would add a build step, an API layer and client state without helping the user.
- **A rule engine, not an LLM.** Extraction advice is well understood and deterministic. Rules are explainable ("sour means under-extracted"), testable and free to run. They are also the core logic, not a wrapper around someone else's API.
- **MongoDB with the native driver, not an ODM.** A brew is a self-contained document of numbers, enums and notes that the engine reads as a whole, so documents fit naturally. All input is already validated in `src/validate.js`, so Mongoose's schema layer would duplicate that. Integrity rules live in **unique indexes**: one account per email, and one brew per form nonce.
- **Embedded MongoDB for development.** Evaluators can clone and run the app without installing a database. In production the embedded server is never used, and the app refuses to start without `MONGODB_URI`.

## Architecture

```
Browser ── HTML forms ──▶ Express
                           │
          ┌────────────────┼──────────────────────────┐
          │ middleware: session cookie → current user, │
          │ CSRF check, flash messages, security hdrs  │
          └────────────────┬──────────────────────────┘
                           │
        src/auth.js        │      src/routes.js
   register / login / ─────┼───── shelf, items, brews, calculator
   logout, rate limit      │      (every query scoped by user_id)
                           │
       src/validate.js ◀───┤───▶ src/engine.js  ◀── src/profiles.js
       (form parsing)      │     (dial-in rules,     (reference ranges per
                           │      freshness, trend)   method / tea type)
                           │            ▲
                           │     src/temperature.js
                           │     (bubble stages, rest times,
                           │      mixing formula, SVG drawings)
                           ▼
                       src/db.js ──▶ MongoDB Atlas (prod) | embedded mongod (dev)
```

- **`src/engine.js`** holds the core logic. It is a set of pure functions with no I/O, which makes it fully unit-tested. `suggest(brew, item, history)` returns `{ headline, reason, changes, alternatives, checks, notes, trend, next }`, where `next` is the concrete recipe for the next attempt.
- **`src/profiles.js`** stores reference ranges: ratio, temperature and time for each coffee method; temperature, leaf ratio, steep time and gongfu increments for each tea type. Light roasts target hotter water and dark roasts cooler water.
- **`src/temperature.js`** holds the bubble stages (60 °C → boil), interpolated kettle rest times, and the mixing formula `boiling share = (target − tap) / (100 − tap)`, which comes from a simple heat balance.

### Data model (MongoDB collections)

```
users  { _id, email, password_hash, created_at }
         index: { email: 1 } unique
items  { _id, user_id, kind: coffee|tea, name, variety, origin, roast_date, notes, created_at }
         index: { user_id: 1, created_at: -1 }
brews  { _id, user_id, item_id, method, dose_g, water_ml, grind, temp_c, temp_cue, time_s,
         infusion, taste, strength, rating: 1–5, notes, nonce, created_at }
         indexes: { user_id: 1, nonce: 1 } unique · { item_id: 1, created_at: -1 } · { user_id: 1, created_at: -1 }
```

`variety` holds the roast level for coffee and the tea type for tea. `temp_cue` records when a temperature was estimated from bubbles rather than measured. Brews reference their item rather than being embedded in it, because brews grow without limit and are queried on their own (recent brews, a single brew page). The dashboard computes each item's brew count and best rating with an aggregation (`$match` → `$group`) instead of loading every brew. Deleting an item deletes its brews first, so a partial failure can never leave orphaned brews.

### Reliability and security

- **Authorization:** every item and brew lookup filters on the logged-in user's id. Someone else's id returns a 404, never their data.
- **Passwords** are hashed with bcrypt. Login attempts are rate-limited per IP, and failed logins do not reveal whether an email exists.
- **CSRF:** every form carries a per-session token that is checked on each POST. Cookies are `httpOnly` and `SameSite=Lax`, and `Secure` in production.
- **Duplicate submissions:** each brew form has a one-time nonce, backed by a unique index. A double click or refresh shows the brew already saved instead of creating a duplicate. Registering with an existing email gives a friendly error.
- **Validation:** all input is checked on the server (ranges, enums, dates not in the future, durations like `2:30`, `45` or `16h`). Invalid forms re-render with messages and keep what you typed.
- **Errors:** custom 404 and 500 pages; malformed ids return 404. Unexpected errors, including a database outage, are logged on the server and shown to users only as a friendly 500 page. If MongoDB is unreachable at startup, the server exits with a clear message instead of serving broken pages.
- **Secrets** live only in environment variables, and the server refuses to start in production without `SESSION_SECRET`.

## Local setup

Requires **Node.js 22.13 or newer**.

```bash
git clone <this repo>
cd brew-journal
npm install
npm run dev        # http://localhost:3000, auto-restarts on changes
npm test           # unit tests + end-to-end tests against an in-memory MongoDB
```

With no `MONGODB_URI`, an embedded MongoDB starts automatically and keeps its data in `.mongo-data/`. The first `npm install` downloads the `mongod` binary for this. To use your own MongoDB instead (a local install or Atlas), copy `.env.example` to `.env` and set `MONGODB_URI`. `npm start` and `npm run dev` load `.env` automatically. Indexes are created on startup.

## Environment variables

See `.env.example`.

| Variable | Required | Description |
|---|---|---|
| `MONGODB_URI` | production | MongoDB connection string (for example from Atlas). If unset in development, an embedded MongoDB is used. |
| `MONGODB_DB` | no | Database name, defaults to `brew-journal`. |
| `SESSION_SECRET` | production | Long random string used to sign session cookies. |
| `NODE_ENV` | production | Set to `production` for secure cookies and static caching. Also disables the embedded database. |
| `PORT` | no | Defaults to `3000`. |

## Deployment

Production runs as two pieces: a **Render** web service for the Node app and a **MongoDB Atlas** free cluster for data.

**1. Database (MongoDB Atlas, free)**
1. Create a free **M0** cluster at [mongodb.com/atlas](https://www.mongodb.com/atlas).
2. Under **Database Access**, add a database user with a strong password. This user is the app's only database credential.
3. Under **Network Access**, allow `0.0.0.0/0`. Render's free plan has no fixed outbound IPs; access is still protected by the user and password.
4. Click **Connect → Drivers** and copy the `mongodb+srv://…` connection string, with the password filled in.

**2. App (Render, free)**
1. Push this repo to GitHub.
2. On [render.com](https://render.com), choose **New → Blueprint** and select the repo. `render.yaml` sets up the service.
3. When prompted, paste the Atlas connection string as `MONGODB_URI`. `SESSION_SECRET` is generated automatically.
4. Open the service URL. Indexes are created on first start.

On the free plan the service sleeps after about 15 minutes idle, so the first request after that takes around 30 seconds. Any other Node host works too: set the environment variables above and run `npm start`.

## Limitations and next steps

- The temperature cues are approximations. They assume sea level, and kettle rest times vary with volume and kettle type.
- Grind suggestions assume a lower number means finer. Free-text grind settings get a direction ("one step finer") instead of a number.
- Possible next steps: a per-user grinder profile, charts of rating over time, and an optional LLM summary of trends layered on top of the rule engine.

## Credits

The brewing ranges come from widely published barista and tea-brewing guidelines. The bubble-stage names come from traditional Chinese tea brewing. All code is original. The bubble illustrations are SVGs generated in code.
