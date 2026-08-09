const AGENTS_BLOCK_PREFIX = '# AGENTS.md instructions';

const INJECTED_TAGS = [
  'permissions instructions',
  'apps_instructions',
  'plugins_instructions',
  'skills_instructions',
  'recommended_plugins',
  'environment_context',
] as const;

export interface CodexPromptExtraction {
  readonly promptText: string | null;
  /** An injected block without its closing tag was kept as-is. */
  readonly hasUnterminatedBlock: boolean;
}

/**
 * Strips known injected blocks (AGENTS.md dumps, permission/environment
 * XML) only when they anchor the START of an input_text block. The same
 * strings appearing mid-text may be user code and are never removed;
 * an unterminated block is kept intact and flagged instead of guessing.
 */
export function extractCodexPrompt(rawTexts: readonly string[]): CodexPromptExtraction {
  let hasUnterminatedBlock = false;
  const kept: string[] = [];
  for (const raw of rawTexts) {
    const stripped = stripLeadingInjectedBlocks(raw);
    if (stripped.unterminated) {
      hasUnterminatedBlock = true;
    }
    if (stripped.text.trim().length > 0) {
      kept.push(stripped.text);
    }
  }
  const joined = kept.join('\n');
  return {
    promptText: joined.trim().length > 0 ? joined : null,
    hasUnterminatedBlock,
  };
}

function stripLeadingInjectedBlocks(text: string): { text: string; unterminated: boolean } {
  let remaining = text;
  for (;;) {
    const trimmed = remaining.trimStart();
    if (trimmed.startsWith(AGENTS_BLOCK_PREFIX)) {
      return { text: '', unterminated: false };
    }
    const tag = INJECTED_TAGS.find((candidate) => trimmed.startsWith(`<${candidate}>`));
    if (tag === undefined) {
      return { text: remaining, unterminated: false };
    }
    const closingTag = `</${tag}>`;
    const closingIndex = trimmed.indexOf(closingTag);
    if (closingIndex === -1) {
      return { text: remaining, unterminated: true };
    }
    remaining = trimmed.slice(closingIndex + closingTag.length);
  }
}
