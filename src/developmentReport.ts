import { buildDevelopmentContext, getDevelopmentEvidence, type DevelopmentContext } from './developmentModel';
import type { ProjectSnapshot } from './model';
import type { WorkingChange } from './workingChanges';

export interface DevelopmentReportOptions {
  scope: 'file' | 'changes';
  paths: readonly string[];
  changes?: readonly WorkingChange[];
  dirtyPaths?: readonly string[];
  stale?: boolean;
}

/** A review aid containing file paths and static evidence, never file contents. */
export function developmentReviewMarkdown(snapshot: ProjectSnapshot, options: DevelopmentReportOptions): string {
  const context = buildDevelopmentContext(snapshot, options.paths);
  const lines = [
    '# Repogram development review', '',
    `Workspace: ${code(snapshot.projectName)}`,
    `Scope: ${options.scope === 'changes' ? 'Git working changes' : 'Selected file'}`,
    `Saved-file analysis: ${snapshot.generatedAt}`, '',
    '> Static import relationships suggest what to inspect. They do not prove runtime impact or test coverage. Tests were not run.', '',
  ];
  if (options.stale) {
    lines.push('> The workspace has changed since this analysis. Refresh before relying on these results.', '');
  }
  if (options.dirtyPaths?.length) {
    section(lines, 'Unsaved files (edits are not included)', options.dirtyPaths, (path) => code(path));
  }
  if (options.scope === 'changes') {
    section(lines, 'Git changes', options.changes ?? [], (change) => {
      const flags = [change.staged && 'staged', change.unstaged && 'working tree', change.untracked && 'untracked',
        change.deleted && 'deleted', change.renamed && 'renamed', change.conflict && 'conflict'].filter(Boolean);
      return `${code(change.path)} — ${flags.join(', ')}${change.originalPath ? ` (from ${code(change.originalPath)})` : ''}`;
    });
    lines.push('Impact uses the saved working tree, including unstaged edits; it is not an analysis of the staged diff or a Git history comparison.', '');
  }
  section(lines, 'Selected files', context.seeds, (file) => code(file.path));
  section(lines, 'Not in this analysis', context.unindexedPaths, (path) => code(path));
  if (context.unindexedPaths.length) {
    lines.push('Deleted, renamed, excluded or unsupported files can be absent. Missing results do not mean a change is safe; inspect their former callers and configuration manually.', '');
  }
  section(lines, 'Direct dependents', context.directDependents, (file) => evidenceSummary(context, file.path));
  section(lines, 'Indirect dependents', context.transitiveDependents, (file) => `${evidenceSummary(context, file.path)} (${file.distance} import steps)`);
  section(lines, 'Direct dependencies', context.directDependencies, (file) => code(file.path));
  section(lines, 'Tests to inspect', context.suggestedTests, (file) => `${code(file.path)} — ${file.reason === 'dependency' ? 'connected through imports' : 'filename match only; relevance unverified'}`);
  lines.push('## Review checklist', '',
    '- [ ] Check affected callers and any public interfaces.',
    '- [ ] Inspect the suggested tests and run the relevant checks in the project.',
    '- [ ] Review unresolved imports, configuration changes, and dynamic usage manually.',
    '- [ ] Save edits and refresh Repogram before final review.', '');
  if (snapshot.diagnostics.length) {
    section(lines, 'Analysis notes', snapshot.diagnostics, (note) => `${code(note.code)}: ${note.message.replace(/[\r\n]+/g, ' ')}`);
  }
  return lines.join('\n');
}

function evidenceSummary(context: DevelopmentContext, path: string): string {
  const edges = getDevelopmentEvidence(context, path);
  if (!edges.length) {
    return code(path);
  }
  const first = edges[0];
  return `${code(path)} — ${edges.length === 1 ? 'imports' : 'reaches'} ${code(edges.at(-1)?.to ?? '')}; import in ${code(`${first?.from ?? path}:${first?.line ?? 1}`)}`;
}

function section<T>(lines: string[], title: string, items: readonly T[], format: (item: T) => string): void {
  const limit = 150;
  lines.push(`## ${title} (${items.length})`, '');
  lines.push(...items.slice(0, limit).map((item) => `- ${format(item)}`));
  if (!items.length) {
    lines.push('None detected.');
  }
  if (items.length > limit) {
    lines.push(`- … ${items.length - limit} additional items. Explore the full list in Repogram.`);
  }
  lines.push('');
}

function code(value: string): string {
  const text = value.replace(/[\r\n]+/g, ' ');
  const delimiter = '`'.repeat(Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length)) + 1);
  return `${delimiter} ${text} ${delimiter}`;
}
