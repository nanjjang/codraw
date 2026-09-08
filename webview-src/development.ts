import {
  buildDevelopmentContext,
  getDevelopmentEvidence,
} from '../src/developmentModel';
import type { ProjectSnapshot } from '../src/model';
import type { WorkingChange, WorkingChangesState } from '../src/workingChanges';
import './development.css';

type DevelopmentContext = ReturnType<typeof buildDevelopmentContext>;
type DevelopmentFile = DevelopmentContext['seeds'][number];
type ImpactFile = DevelopmentContext['directDependents'][number];
type RelatedTest = DevelopmentContext['suggestedTests'][number];
type Evidence = ReturnType<typeof getDevelopmentEvidence>;
type Scope = 'file' | 'changes';

const PAGE_SIZE = 6;

/** A saved-source review aid that follows the editor or a selected Git change. */
export class DevelopmentView {
  private snapshot: ProjectSnapshot | undefined;
  private activePath: string | undefined;
  private changes: WorkingChangesState = { status: 'loading', changes: [] };
  private changesSignature = '';
  private dirtyPaths: readonly string[] = [];
  private dirtySignature = '';
  private stale = false;
  private scope: Scope = 'file';
  private pinnedPath: string | undefined;
  private readonly visibleCounts = new Map<string, number>();

  constructor(
    private readonly root: HTMLElement,
    private readonly postMessage: (message: unknown) => void,
  ) {
    root.classList.add('dev-view');
    this.render();
  }

  update(
    snapshot: ProjectSnapshot | undefined,
    activePath: string | undefined,
    changes: WorkingChangesState,
    dirtyPaths: readonly string[],
    stale: boolean,
  ): void {
    const changesSignature = JSON.stringify(changes);
    const dirtySignature = JSON.stringify(dirtyPaths);
    if (
      this.snapshot === snapshot &&
      this.activePath === activePath &&
      this.changesSignature === changesSignature &&
      this.dirtySignature === dirtySignature &&
      this.stale === stale
    ) {
      return;
    }
    this.snapshot = snapshot;
    this.activePath = activePath;
    this.changes = changes;
    this.changesSignature = changesSignature;
    this.dirtyPaths = dirtyPaths;
    this.dirtySignature = dirtySignature;
    this.stale = stale;
    this.render();
  }

  focus(scope: Scope, path?: string): void {
    this.scope = scope;
    if (scope === 'file') {
      this.pinnedPath = path;
    }
    this.visibleCounts.clear();
    this.render();
  }

  private render(): void {
    this.root.replaceChildren(this.renderScopeSwitch());
    const path = this.pinnedPath ?? this.activePath;
    const seedPaths = this.scope === 'file'
      ? path ? [path] : []
      : [...new Set(this.changes.changes.flatMap((change) => [change.path, ...(change.originalPath ? [change.originalPath] : [])]))];
    const context = this.snapshot && seedPaths.length > 0
      ? buildDevelopmentContext(this.snapshot, seedPaths)
      : undefined;

    if (this.scope === 'file') {
      this.root.append(this.renderCurrentFile(path, context));
    } else {
      this.root.append(this.renderChangesHeader(context));
    }

    if (this.stale && this.snapshot) {
      this.root.append(notice('Workspace files changed after this analysis. Refresh to update the import links before reviewing impact.'));
    }
    if (this.dirtyPaths.length > 0) {
      const message = this.scope === 'file' && path && this.dirtyPaths.includes(path)
        ? 'This file has unsaved edits. Import links describe the last saved source; save the file and refresh to include your edits.'
        : `${this.dirtyPaths.length} open ${plural(this.dirtyPaths.length, 'file has', 'files have')} unsaved edits. Import links and Git changes do not include unsaved editor content.`;
      this.root.append(notice(message));
    }

    if (this.scope === 'changes') {
      if (this.changes.status === 'loading') {
        this.root.append(note('Reading Git changes…', 'dev-empty'));
        return;
      }
      if (this.changes.status === 'unavailable') {
        this.root.append(notice(this.changes.message ?? 'Git changes are unavailable. Open a Git repository with the built-in Git extension enabled.'));
        this.root.append(note('Use Current file to inspect the saved-source import links.', 'dev-empty'));
        return;
      }
      if (this.changes.message) {
        this.root.append(notice(this.changes.message));
      }
      if (this.changes.changes.length === 0) {
        this.root.append(note('No staged, working-tree, or untracked changes in this workspace.', 'dev-empty'));
        return;
      }
      this.root.append(this.createGroup(
        'changes',
        'Changed files',
        'Open a file or inspect its individual import impact.',
        this.changes.changes,
        'No changes match this filter.',
        (change) => this.renderChange(change),
        (change, query) => change.path.toLocaleLowerCase().includes(query),
      ));
    } else if (!path) {
      this.root.append(note('Open a file in this workspace to see its dependencies, affected files, and related tests.', 'dev-empty'));
      return;
    }

    if (!this.snapshot) {
      this.root.append(note('Analyze the workspace to build saved-source import links.', 'dev-empty'));
      return;
    }
    if (!context) {
      return;
    }

    if (context.unindexedPaths.length > 0) {
      this.root.append(this.createGroup(
        'unindexed',
        'Outside the analysis',
        'Deleted, excluded, unsupported, or newly added files may have no import evidence. Refresh after saving; missing evidence does not mean no impact.',
        context.unindexedPaths,
        '',
        (unindexedPath) => this.renderUnindexed(unindexedPath),
      ));
    }

    if (context.seeds.length === 0) {
      return;
    }
    this.root.append(this.renderCounts(context));
    this.root.append(note('Potential impact follows static imports between indexed files. Dynamic calls, runtime behavior, and unindexed files can add dependencies.'));
    this.root.append(this.createGroup(
      'direct',
      'Directly affected',
      'Files that import a selected file.',
      context.directDependents,
      'No direct importers found in the indexed source.',
      (file) => this.renderImpact(file, context),
    ));
    this.root.append(this.createGroup(
      'indirect',
      'Indirectly affected',
      'Files connected through two or more import steps.',
      context.transitiveDependents,
      'No additional importers found beyond the direct links.',
      (file) => this.renderImpact(file, context),
    ));
    this.root.append(this.createGroup(
      'dependencies',
      'Depends on',
      'Indexed files imported by the selection.',
      context.directDependencies,
      'No local file dependencies found in the indexed source.',
      (file) => {
        const item = this.renderFile(file);
        item.append(this.renderEvidence('Import evidence', () => [file.via]));
        return item;
      },
    ));
    this.root.append(this.createGroup(
      'tests',
      'Related tests',
      'Review candidates from import links or file names. Tests are not run and coverage is not measured.',
      context.suggestedTests,
      'No related tests found by imports or file names. This does not show whether the change is tested.',
      (file) => this.renderTest(file, context),
    ));
  }

  private renderScopeSwitch(): HTMLElement {
    const container = element('div', 'dev-switch');
    container.setAttribute('role', 'group');
    container.setAttribute('aria-label', 'Development context');
    for (const [scope, label] of [['file', 'Current file'], ['changes', 'Git changes']] as const) {
      const button = action(label, () => {
        this.scope = scope;
        this.visibleCounts.clear();
        this.render();
      }, 'dev-switch-button');
      button.setAttribute('aria-pressed', String(this.scope === scope));
      container.append(button);
    }
    return container;
  }

  private renderCurrentFile(path: string | undefined, context: DevelopmentContext | undefined): HTMLElement {
    const card = element('section', 'dev-card');
    card.append(element('span', 'dev-eyebrow', this.pinnedPath ? 'Pinned file' : 'Following the active editor'));
    card.append(element('h2', 'dev-card-title', path ? basename(path) : 'Your development context'));
    if (!path) {
      return card;
    }
    card.append(element('p', 'dev-path', path));
    const change = this.changeFor(path);
    const badges = this.renderStatusBadges(change, path);
    if (badges.childElementCount > 0) {
      card.append(badges);
    }
    const actions = element('div', 'dev-actions');
    const open = action('Open file', () => this.openSource(path));
    open.disabled = Boolean(change?.deleted) || (!context?.seeds.length && !change);
    if (open.disabled) {
      open.title = change?.deleted ? 'This file is deleted from the working tree.' : 'The file is not indexed in this workspace.';
    }
    actions.append(open);
    actions.append(action(this.pinnedPath ? 'Follow editor' : 'Pin file', () => {
      this.pinnedPath = this.pinnedPath ? undefined : path;
      this.visibleCounts.clear();
      this.render();
    }));
    actions.append(this.copyButton(Boolean(context), path));
    card.append(actions);
    return card;
  }

  private renderChangesHeader(context: DevelopmentContext | undefined): HTMLElement {
    const card = element('section', 'dev-card');
    const changes = this.changes.changes;
    card.append(element('span', 'dev-eyebrow', 'Workspace review'));
    card.append(element('h2', 'dev-card-title', `${changes.length} changed ${plural(changes.length, 'file', 'files')}`));
    const counts = [
      [changes.filter((change) => change.staged).length, 'staged'],
      [changes.filter((change) => change.unstaged && !change.untracked).length, 'working'],
      [changes.filter((change) => change.untracked).length, 'untracked'],
      [changes.filter((change) => change.conflict).length, 'conflicts'],
    ] as const;
    const status = counts.filter(([count]) => count > 0).map(([count, label]) => `${count} ${label}`).join(' · ');
    if (status) {
      card.append(note(status));
    }
    card.append(note('Impact uses saved working-tree files, including unstaged edits. It is not a staged-diff or Git history analysis.'));
    const actions = element('div', 'dev-actions');
    actions.append(this.copyButton(Boolean(context) && this.changes.status === 'ready'));
    card.append(actions);
    return card;
  }

  private copyButton(enabled: boolean, path?: string): HTMLButtonElement {
    const button = action('Copy review notes', () => {
      this.postMessage({ type: 'copyDevelopmentReview', scope: this.scope, ...(path ? { path } : {}) });
    }, 'dev-button dev-button-primary');
    button.disabled = !enabled;
    button.title = enabled
      ? 'Copy a Markdown summary of this selection, import impact, and related tests.'
      : 'Analyze a selected file or Git changes to prepare review notes.';
    return button;
  }

  private renderCounts(context: DevelopmentContext): HTMLElement {
    const counts = element('div', 'dev-counts');
    counts.setAttribute('aria-label', 'Potential impact summary');
    for (const [label, value] of [
      ['Direct', context.directDependents.length],
      ['Indirect', context.transitiveDependents.length],
      ['Tests', context.suggestedTests.length],
    ] as const) {
      const item = element('div', 'dev-count');
      item.append(element('span', 'dev-count-value', String(value)), element('span', 'dev-count-label', label));
      counts.append(item);
    }
    return counts;
  }

  private renderChange(change: WorkingChange): HTMLLIElement {
    const item = element('li', 'dev-list-item');
    item.append(this.sourceButton(change.path, change.deleted));
    if (change.originalPath && change.originalPath !== change.path) {
      item.append(note(`Renamed from ${change.originalPath}`));
    }
    item.append(this.renderStatusBadges(change, change.path));
    if (change.deleted) {
      item.append(note('Deleted from the working tree. Import evidence may be incomplete until the next scan.'));
    }
    const actions = element('div', 'dev-row-actions');
    const inspect = action('Inspect impact', () => this.focus('file', change.path));
    inspect.setAttribute('aria-label', `Inspect impact of ${change.path}`);
    actions.append(inspect);
    item.append(actions);
    return item;
  }

  private renderUnindexed(path: string): HTMLLIElement {
    const item = element('li', 'dev-list-item');
    const change = this.changeFor(path);
    item.append(this.sourceButton(path, !change || change.deleted));
    item.append(note(change?.deleted ? 'Deleted · not present in this analysis' : 'No saved-source import data'));
    return item;
  }

  private renderFile(file: DevelopmentFile): HTMLLIElement {
    const item = element('li', 'dev-list-item');
    item.append(this.sourceButton(file.path, Boolean(this.changeFor(file.path)?.deleted)));
    const badges = this.renderStatusBadges(this.changeFor(file.path), file.path);
    if (badges.childElementCount > 0) {
      item.append(badges);
    }
    return item;
  }

  private renderImpact(file: ImpactFile, context: DevelopmentContext): HTMLLIElement {
    const item = this.renderFile(file);
    item.append(this.renderEvidence(
      file.distance === 1 ? 'Why affected · direct import' : `Why affected · ${file.distance} import steps`,
      () => getDevelopmentEvidence(context, file.path),
    ));
    return item;
  }

  private renderTest(file: RelatedTest, context: DevelopmentContext): HTMLLIElement {
    const item = this.renderFile(file);
    if (file.reason === 'dependency') {
      item.append(this.renderEvidence(
        file.distance === 1 ? 'Related by direct import' : `Related by imports${file.distance ? ` · ${file.distance} steps` : ''}`,
        () => getDevelopmentEvidence(context, file.path),
      ));
    } else {
      const badges = element('div', 'dev-badges');
      badges.append(element('span', 'dev-badge dev-badge-warning', 'File name match · heuristic'));
      item.append(badges, note('Similar file name; no import relationship was found.'));
    }
    return item;
  }

  private renderEvidence(label: string, getEvidence: () => Evidence): HTMLDetailsElement {
    const details = element('details', 'dev-evidence');
    details.append(element('summary', '', label));
    let populated = false;
    details.addEventListener('toggle', () => {
      if (!details.open || populated) {
        return;
      }
      populated = true;
      const evidence = getEvidence();
      if (evidence.length === 0) {
        details.append(note('No import chain is available in this snapshot.'));
        return;
      }
      const list = element('ol', 'dev-evidence-list');
      for (const edge of evidence) {
        const step = element('li');
        const content = element('div', 'dev-evidence-step');
        content.append(action(edge.from, () => this.openSource(edge.from, edge.line), 'dev-evidence-link'));
        content.append(element('span', '', `imports ${edge.to}`));
        content.append(element('span', '', `Line ${edge.line} · static ${edge.confidence} resolution`));
        step.append(content);
        list.append(step);
      }
      details.append(list);
    });
    return details;
  }

  private sourceButton(path: string, disabled = false): HTMLButtonElement {
    const button = action('', () => this.openSource(path), 'dev-file-link');
    button.disabled = disabled;
    button.title = path;
    button.setAttribute('aria-label', disabled ? path : `Open ${path}`);
    const deleted = this.changeFor(path)?.deleted;
    button.append(element('span', deleted ? 'dev-file-name dev-deleted-path' : 'dev-file-name', basename(path)));
    const directory = path.slice(0, Math.max(0, path.lastIndexOf('/')));
    if (directory) {
      button.append(element('span', 'dev-file-directory', directory));
    }
    return button;
  }

  private renderStatusBadges(change: WorkingChange | undefined, path: string): HTMLElement {
    const badges = element('div', 'dev-badges');
    if (change?.conflict) {
      badges.append(element('span', 'dev-badge dev-badge-conflict', 'Conflict'));
    }
    if (change?.staged) {
      badges.append(element('span', 'dev-badge dev-badge-staged', 'Staged'));
    }
    if (change?.unstaged && !change.untracked) {
      badges.append(element('span', 'dev-badge', 'Working tree'));
    }
    if (change?.untracked) {
      badges.append(element('span', 'dev-badge', 'Untracked'));
    }
    if (change?.renamed) {
      badges.append(element('span', 'dev-badge', 'Renamed'));
    }
    if (change?.deleted) {
      badges.append(element('span', 'dev-badge dev-badge-deleted', 'Deleted'));
    }
    if (this.dirtyPaths.includes(path)) {
      badges.append(element('span', 'dev-badge dev-badge-warning', 'Unsaved'));
    }
    return badges;
  }

  private createGroup<T>(
    key: string,
    title: string,
    description: string,
    items: readonly T[],
    emptyMessage: string,
    renderItem: (item: T) => HTMLElement,
    filter?: (item: T, query: string) => boolean,
  ): HTMLElement {
    const group = element('section', 'dev-group');
    const header = element('div', 'dev-group-header');
    const heading = element('h3', 'dev-group-title', title);
    const count = element('span', 'dev-group-count', String(items.length));
    heading.append(count);
    header.append(heading, note(description, 'dev-group-description'));
    const list = element('ul', 'dev-list');
    const empty = note(emptyMessage, 'dev-empty');
    const more = action('', () => {
      this.visibleCounts.set(key, (this.visibleCounts.get(key) ?? PAGE_SIZE) + PAGE_SIZE);
      appendVisible();
    }, 'dev-button dev-show-more');
    let filtered = items;
    let renderedCount = 0;
    const appendVisible = (): void => {
      const limit = Math.min(filtered.length, this.visibleCounts.get(key) ?? PAGE_SIZE);
      for (const item of filtered.slice(renderedCount, limit)) {
        list.append(renderItem(item));
      }
      renderedCount = limit;
      const remaining = filtered.length - limit;
      more.hidden = remaining === 0;
      more.textContent = `Show ${Math.min(PAGE_SIZE, remaining)} more · ${remaining} remaining`;
      more.setAttribute('aria-label', `Show more ${title.toLocaleLowerCase()}, ${remaining} remaining`);
      empty.hidden = filtered.length > 0;
      count.textContent = filtered.length === items.length ? String(items.length) : `${filtered.length} / ${items.length}`;
    };
    if (filter && items.length > PAGE_SIZE) {
      const input = element('input', 'dev-filter');
      input.type = 'search';
      input.placeholder = 'Filter changed files…';
      input.setAttribute('aria-label', 'Filter changed files by path');
      input.addEventListener('input', () => {
        const query = input.value.trim().toLocaleLowerCase();
        filtered = query ? items.filter((item) => filter(item, query)) : items;
        renderedCount = 0;
        this.visibleCounts.delete(key);
        list.replaceChildren();
        appendVisible();
      });
      header.append(input);
    }
    group.append(header, list, empty, more);
    appendVisible();
    return group;
  }

  private changeFor(path: string): WorkingChange | undefined {
    return this.changes.changes.find((change) => change.path === path);
  }

  private openSource(path: string, line?: number): void {
    if (!this.changeFor(path)?.deleted) {
      this.postMessage({ type: 'openDevelopmentSource', path, ...(line ? { line } : {}) });
    }
  }
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  text?: string,
): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag);
  if (className) {
    result.className = className;
  }
  if (text !== undefined) {
    result.textContent = text;
  }
  return result;
}

function action(label: string, onClick: () => void, className = 'dev-button'): HTMLButtonElement {
  const button = element('button', className, label);
  button.type = 'button';
  button.addEventListener('click', onClick);
  return button;
}

function note(message: string, className = 'dev-note'): HTMLParagraphElement {
  return element('p', className, message);
}

function notice(message: string): HTMLParagraphElement {
  return note(message, 'dev-notice');
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function plural(count: number, singular: string, multiple: string): string {
  return count === 1 ? singular : multiple;
}
