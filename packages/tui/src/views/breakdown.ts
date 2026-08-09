import { buildTableSummary, renderBreakdownTable } from '../components/breakdown-table.ts';
import { joinLine, span } from '../rich-text.ts';
import { sortSpecFor } from '../state.ts';
import type { TuiState } from '../state.ts';
import { fitLine } from '../text.ts';
import type { ResourceState } from '../types.ts';
import { sortBreakdownRows } from '../view-model/breakdown.ts';
import type { BreakdownTabViewModel } from '../view-model/breakdown.ts';
import { renderPromptList } from './prompts.ts';
import type { TabView, TabViewLine } from './shell.ts';

/** Prompts for the model the user opened from the Models table. */
function modelPromptsView(state: TuiState, width: number, height: number): readonly TabViewLine[] {
  const resource = state.modelPrompts;
  const header: TabViewLine[] = [
    joinLine(' ', span('Esc', 'key'), span(' back to models', 'muted')),
    '',
  ];
  if (resource.data === null) {
    header.push(
      fitLine(
        resource.phase === 'error'
          ? `  prompts unavailable: ${resource.error ?? 'unknown error'}`
          : '  loading prompts…',
        width,
      ),
    );
    return header;
  }
  const rendered = renderPromptList({
    model: resource.data,
    cursor: state.modelPromptsCursor,
    width,
    height: height - header.length,
  });
  return [...header, ...rendered.lines];
}

function breakdownView(
  tab: 'agents' | 'models',
  select: (state: TuiState) => ResourceState<BreakdownTabViewModel>,
  noun: string,
): TabView {
  return (state, width, height): readonly TabViewLine[] => {
    if (tab === 'models' && state.modelDrillDown !== null) {
      return modelPromptsView(state, width, height);
    }
    const resource = select(state);
    const model = resource.data;
    if (model === null) {
      if (resource.phase === 'loading') {
        return [fitLine(`  loading ${noun}…`, width)];
      }
      if (resource.phase === 'error') {
        return [fitLine(`  ${noun} unavailable: ${resource.error ?? 'unknown error'}`, width)];
      }
      return [fitLine(`  ${noun} not loaded yet`, width)];
    }
    if (model.rows.length === 0) {
      return ['', fitLine('  ledger is empty — press r to collect your agent logs', width)];
    }
    const sort = sortSpecFor(state, tab);
    const sorted: BreakdownTabViewModel = { ...model, rows: sortBreakdownRows(model.rows, sort) };
    const tableRows = Math.max(3, height - 8);
    const lines: TabViewLine[] = [
      '',
      buildTableSummary(sorted, sort),
      ...renderBreakdownTable(sorted, width, tableRows, sort, tab === 'models' ? state.modelsCursor : -1),
      '',
    ];
    for (const warning of model.pricing.warnings.slice(0, 2)) {
      lines.push(joinLine(span(fitLine(`  ! ${warning}`, width), 'warning')));
    }
    if (resource.phase === 'error') {
      lines.push(
        joinLine(
          span(
            fitLine(`  ! refresh failed: ${resource.error ?? 'unknown'} (showing last data)`, width),
            'danger',
          ),
        ),
      );
    }
    return lines;
  };
}

export const agentsTabView: TabView = breakdownView('agents', (state) => state.agents, 'agents');
export const modelsTabView: TabView = breakdownView('models', (state) => state.models, 'models');
