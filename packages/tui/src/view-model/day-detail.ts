import type { ReportSummary } from '@llmtally/core/report/types.ts';

import { toBreakdownViewModel } from './breakdown.ts';
import type { BreakdownRowViewModel } from './breakdown.ts';

/**
 * One agent's usage on the selected day, with its own models nested —
 * agents and models are parent and child, not two parallel lists, and
 * the view renders them that way (one card per agent).
 */
export interface DayAgentDetailViewModel {
  readonly agent: BreakdownRowViewModel;
  readonly models: readonly BreakdownRowViewModel[];
}

export interface DayDetailViewModel {
  readonly date: string;
  /** Busiest agent first; models inside each follow the same order. */
  readonly agents: readonly DayAgentDetailViewModel[];
}

export function toDayDetailViewModel(
  date: string,
  agents: ReportSummary,
  modelsByAgent: Readonly<Record<string, ReportSummary>>,
): DayDetailViewModel {
  return {
    date,
    agents: toBreakdownViewModel('agent', agents).rows.map((agent) => {
      const models = modelsByAgent[agent.key];
      return {
        agent,
        models: models === undefined ? [] : toBreakdownViewModel('model', models).rows,
      };
    }),
  };
}
