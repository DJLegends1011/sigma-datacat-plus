// DataCat Plus — Project Σ extension server half (AGPL-3.0-only, adapted from Character Library).
import { T_SESSIONS, registerDataCatRoutes } from './datacat-routes.js';

export const migrations = [
    `CREATE TABLE IF NOT EXISTS ${T_SESSIONS} (
        user_handle TEXT PRIMARY KEY,
        anon_token TEXT,
        device_token TEXT,
        account_token TEXT,
        user_json TEXT,
        updated_at INTEGER NOT NULL
    )`,
];

/** @type {import('../../../ProjectSigma-main/docs/extensions').ServerExtension['register']} */
export function register(router, ctx) {
    registerDataCatRoutes(router, ctx);
}
