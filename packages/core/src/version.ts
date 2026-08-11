/**
 * Single version source for every outgoing identification. The root
 * package.json is the only place the version lives; per-package
 * manifests must not grow their own copies (UA drift would silently
 * split the vendor-side request budget pools).
 */
import rootPackage from '../../../package.json' with { type: 'json' };

export const LLMTALLY_VERSION: string = rootPackage.version;

/**
 * Sent on vendor quota/token requests. A stable, explicit UA keeps the
 * per-token request budget pinned to one pool instead of drifting with
 * the runtime's default UA across upgrades.
 */
export const LLMTALLY_USER_AGENT = `llmtally/${LLMTALLY_VERSION}`;
