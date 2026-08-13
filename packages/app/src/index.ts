/**
 * Public entry of @llmtally/app: the sidecar server factory, so tests
 * and tooling import the same seam the bundled helper runs.
 */
export { createSidecarServer } from './sidecar-main.ts';
export type { SidecarOptions } from './api.ts';
