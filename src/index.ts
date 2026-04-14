/**
 * dario — programmatic API
 *
 * Use this if you want to embed dario in your own app
 * instead of running the CLI.
 */

export { startAutoOAuthFlow, refreshTokens, getAccessToken, getStatus, loadCredentials } from './oauth.js';
export type { OAuthTokens, CredentialsFile } from './oauth.js';
export { startProxy, sanitizeError } from './proxy.js';

// Multi-account pool API (pool activates automatically when ~/.dario/accounts/
// contains 2+ accounts; see README for the progression from single-account
// mode to pool mode).
export { AccountPool, parseRateLimits } from './pool.js';
export type { PoolAccount, PoolStatus, RateLimitSnapshot, AccountIdentity } from './pool.js';
export {
  listAccountAliases,
  loadAccount,
  loadAllAccounts,
  saveAccount,
  removeAccount,
  refreshAccountToken,
  addAccountViaOAuth,
  getAccountsDir,
} from './accounts.js';
export type { AccountCredentials } from './accounts.js';
export { Analytics } from './analytics.js';
export type { RequestRecord, AnalyticsSummary } from './analytics.js';
