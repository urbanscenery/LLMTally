import { joinLine, span } from '../rich-text.ts';
import type { TuiState } from '../state.ts';
import { fitLine } from '../text.ts';
import { renderPromptList } from './prompts.ts';
import type { TabView, TabViewLine } from './shell.ts';

/** The query line doubles as the input field; `/` starts editing. */
function queryLine(state: TuiState, editing: boolean): TabViewLine {
  const query = state.searchQuery;
  return joinLine(
    ' ',
    span('search ', 'tableHeader'),
    span(query === '' ? '(type / to search prompts)' : query, query === '' ? 'dim' : 'default'),
    span(editing ? '█' : '', 'accent'),
  );
}

export const searchTabView: TabView = (
  state: TuiState,
  width: number,
  height: number,
): readonly TabViewLine[] => {
  const editing = state.overlay?.kind === 'input';
  const lines: TabViewLine[] = [queryLine(state, editing), ''];
  const resource = state.search;
  if (state.searchQuery === '') {
    lines.push(fitLine('  press / to type a query, Enter to run it', width));
    return lines;
  }
  if (resource.data === null) {
    lines.push(
      fitLine(
        resource.phase === 'error'
          ? `  search failed: ${resource.error ?? 'unknown error'}`
          : '  searching…',
        width,
      ),
    );
    return lines;
  }
  const rendered = renderPromptList({
    model: resource.data,
    cursor: state.searchCursor,
    width,
    height: height - lines.length,
  });
  lines.push(...rendered.lines);
  return lines;
};
