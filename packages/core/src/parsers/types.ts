import type { JsonObject } from '../domain/types.ts';
import type {
  AdapterScanOptions,
  ScanBatch,
  ScanWarning,
  SourceTarget,
  StoredScanState,
} from '../scan/types.ts';

export interface SourceDiscoveryContext {
  readonly homeDirectory: string;
  readonly agentFilter: string | null;
}

export interface SourceDiscovery {
  readonly targets: readonly SourceTarget[];
  readonly warnings: readonly ScanWarning[];
}

/**
 * A source adapter discovers and parses one agent's local logs.
 * Adapters never touch the database; all persistence goes through
 * the coordinator so cursor commits stay transactional.
 */
export interface SourceAdapter<TCursor extends JsonObject = JsonObject> {
  readonly agent: string;
  readonly parserVersion: number;

  discover(context: SourceDiscoveryContext): Promise<SourceDiscovery>;

  scan(
    target: SourceTarget,
    state: StoredScanState | null,
    options: AdapterScanOptions,
  ): AsyncIterable<ScanBatch<TCursor>>;
}
