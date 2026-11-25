# DataCat Plus

A Project Sigma provider extension that brings Character Library's full DataCat (`datacat.run`) browsing, search (DataCat API, JanitorAI MeiliSearch, and Hampter sorts), cloud extraction, account-synced Collected/folder management, following manager, and missing-avatar restore into Sigma.

## Installation Note

While **DataCat Plus** is enabled, **switch off Sigma's built-in DataCat provider** in Settings -> Online to avoid duplicate provider tabs and DOM ID collisions.

## Privacy, Storage & Network

- **What it reads**: Extension settings (`datacatNsfw`, `datacatPublicFeed`, `datacatReextractOnUpdate`, `datacatSyncYours`, `datacatUseAccountForExtraction`, `datacatFollowedCreators`, `datacatFollowMigrated`), your Sigma character list for in-library badges and avatar restore, and the app-wide `importMediaAction` setting.
- **What it writes**: Its own server-side session/account storage table (per Sigma account) and its own extension settings under `datacat-plus`. Characters you import are saved through Sigma's normal character import pipeline with link metadata under `data.extensions[PROVIDER_ID]`.
- **What it sends and where**:
  - Browse, search, extraction, folder, and follow requests go to `datacat.run` (and `ella.janitorai.com` for avatars / JanitorAI MeiliSearch where selected) through this extension's server half at `/api/ext/datacat-plus/dc-*`.
  - When you sign in to a DataCat account, your email and password are sent **only** in the POST body to `datacat.run` (`/api/auth/login`) via this extension's server half. The password input is cleared immediately after submission and is never stored. Account and anonymous session tokens are kept server-side only (never stored in client settings).
  - **JanitorAI login (optional, for the Hampter sorts):** the session you paste is stored server-side per Sigma account (table `x_datacat_plus_jai`), and the refresh token never leaves the server. The page asks `/api/ext/datacat-plus/jai-token` for a current, short-lived **access** token when it pages a Hampter sort, because that request runs in your browser (which holds JanitorAI's Cloudflare pass) and goes straight to JanitorAI. An earlier build kept the pair in client settings; on first start it is handed to the server and cleared from settings.

## Licence

**AGPL-3.0** — derived from [Character Library](https://github.com/Sillyanonymous/SillyTavern-CharacterLibrary) (Sillyanonymous and contributors) and DJLegends' DataCat branch (`codex/datacat-account-sync`).

## Next Steps

- **Side-by-side check**: compare every control with Sigma's own DataCat in a throwaway Sigma (the 2026-11-24 parity audit's fixes are in; behaviour not yet checked in a browser).
- **Real-account login test**: Verify end-to-end login, folder sync, follow sync, and account-backed extraction against a live `datacat.run` account.
- **Hosted-browser fallback**: Add a hosted-browser fallback if Cloudflare begins challenging server-side requests.
- **Namespace migration**: Switch the namespace to `datacat` once Sigma retires its built-in DataCat (change `PROVIDER_ID` + manifest `extNamespace`) and migrate cards linked under `datacat-plus` to `datacat` (rewrite `data.extensions.datacat-plus` -> `datacat` through `ctx.stores.characters`) so nothing imported in the meantime is orphaned.
