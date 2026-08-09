/**
 * Domain layer: reading agent logs, the ledger, pricing, quota, and
 * account management. Knows nothing about terminals or rendering.
 * Consumers import subpaths (`@llmtally/core/quota/service.ts`); this
 * barrel names the pieces most callers start from.
 */
export { openDatabase, openReadOnlyDatabase } from './db/connection.ts';
export { LATEST_SCHEMA_VERSION, migrate } from './db/migrate.ts';
export { generateReport } from './report/service.ts';
export { createDefaultCoordinator } from './scan/coordinator.ts';
export { runDoctorChecks } from './doctor/checks.ts';
export { loadAllQuota } from './quota/service.ts';
export { AccountVault } from './accounts/vault.ts';
export { discoverAccounts } from './accounts/discovery.ts';
export { switchAccount, captureActiveAccount } from './accounts/switch.ts';
export { createActiveCredentialStore } from './accounts/credentials.ts';
export { sanitizeTerminalLine, sanitizeTerminalBlock } from './terminal/sanitize.ts';
