import * as vscode from 'vscode';
import { workspacePath } from './workspacePaths';

export interface WorkingChange {
  path: string;
  originalPath?: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  deleted: boolean;
  renamed: boolean;
  conflict: boolean;
}

export interface WorkingChangesState {
  status: 'ready' | 'unavailable' | 'loading';
  changes: WorkingChange[];
  message?: string;
}

// The supported, public API of VS Code's built-in Git extension. Keeping this
// structural subset avoids a dependency on its implementation or on Node APIs.
interface GitChange {
  readonly uri: vscode.Uri;
  readonly originalUri: vscode.Uri;
  readonly status: number;
}

interface GitChanges {
  readonly indexChanges: readonly GitChange[];
  readonly workingTreeChanges: readonly GitChange[];
  readonly mergeChanges: readonly GitChange[];
  readonly untrackedChanges?: readonly GitChange[];
}

interface GitRepository {
  readonly rootUri: vscode.Uri;
  readonly state: GitChanges & { readonly onDidChange: vscode.Event<void> };
  status(): Promise<void>;
}

interface GitApi {
  readonly state: 'uninitialized' | 'initialized';
  readonly repositories: readonly GitRepository[];
  readonly onDidChangeState: vscode.Event<string>;
  readonly onDidOpenRepository: vscode.Event<GitRepository>;
  readonly onDidCloseRepository: vscode.Event<GitRepository>;
}

interface GitExtension {
  readonly enabled: boolean;
  readonly onDidChangeEnablement: vscode.Event<boolean>;
  getAPI(version: 1): GitApi;
}

/** Convert Git's separate resource groups into one row per workspace file. */
export function normalizeWorkingChanges(
  repositories: readonly GitChanges[],
  pathForUri: (uri: vscode.Uri) => string | undefined,
): WorkingChange[] {
  const byPath = new Map<string, WorkingChange>();
  for (const repository of repositories) {
    const groups = [
      { changes: repository.indexChanges, staged: true, untracked: false, conflict: false },
      { changes: repository.workingTreeChanges, staged: false, untracked: false, conflict: false },
      { changes: repository.untrackedChanges ?? [], staged: false, untracked: true, conflict: false },
      { changes: repository.mergeChanges, staged: false, untracked: false, conflict: true },
    ];
    for (const group of groups) {
      for (const change of group.changes) {
        // Public Git API Status: 3 = indexed rename, 10 = intent to rename,
        // 8 = ignored; 12..18 are the seven unresolved merge states.
        if (change.status === 8) {
          continue;
        }
        const renamed = change.status === 3 || change.status === 10;
        const currentPath = pathForUri(change.uri);
        const originalPath = renamed ? pathForUri(change.originalUri) : undefined;
        // A rename out of the opened workspace still removes a source file
        // from that workspace. A rename into it uses the new file's identity.
        const path = currentPath ?? originalPath;
        if (!path) {
          continue;
        }
        const row = byPath.get(path) ?? {
          path, staged: false, unstaged: false, untracked: false,
          deleted: false, renamed: false, conflict: false,
        };
        row.staged ||= group.staged;
        row.unstaged ||= !group.staged;
        row.untracked ||= group.untracked || change.status === 7;
        row.deleted ||= change.status === 2 || change.status === 6 || change.status === 17
          || (renamed && !currentPath);
        row.renamed ||= renamed;
        row.conflict ||= group.conflict || (change.status >= 12 && change.status <= 18);
        if (originalPath && originalPath !== path) {
          row.originalPath ??= originalPath;
        }
        byPath.set(path, row);
      }
    }
  }
  return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
}

/**
 * Reads live Source Control state; never stages, commits or runs a shell.
 * VS Code owns repository detection and refreshes, including remote hosts.
 */
export class WorkingChangesTracker implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<WorkingChangesState>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly apiDisposables: vscode.Disposable[] = [];
  private readonly repositoryListeners = new Map<GitRepository, vscode.Disposable>();
  private gitHandle: vscode.Extension<GitExtension> | undefined;
  private git: GitExtension | undefined;
  private enablementListener: vscode.Disposable | undefined;
  private api: GitApi | undefined;
  private latest: WorkingChangesState = { status: 'loading', changes: [] };
  private inFlight: Promise<void> | undefined;
  private refreshAgain = false;
  private disposed = false;

  readonly onDidChange = this.emitter.event;

  constructor() {
    this.disposables.push(
      this.emitter,
      vscode.workspace.onDidGrantWorkspaceTrust(() => { void this.refresh(); }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => { void this.refresh(); }),
      vscode.extensions.onDidChange(() => { void this.refresh(); }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('git.enabled')) {
          void this.refresh();
        }
      }),
    );
    void this.refresh();
  }

  get current(): WorkingChangesState {
    return this.latest;
  }

  /** Explicit refresh also works when the user has disabled Git auto-refresh. */
  refresh(): Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }
    if (this.inFlight) {
      this.refreshAgain = true;
      return this.inFlight;
    }
    // Every caller awaits the complete coalesced refresh, including a status
    // request received while Git enablement or repository membership changes.
    const run = Promise.resolve().then(async () => {
      do {
        this.refreshAgain = false;
        await this.refreshGit();
      } while (this.refreshAgain && !this.disposed);
    }).finally(() => {
      this.inFlight = undefined;
    });
    this.inFlight = run;
    return run;
  }

  private async refreshGit(): Promise<void> {
    try {
      const blocked = this.unavailableReason();
      if (blocked) {
        this.releaseApi();
        this.update({ status: 'unavailable', changes: [], message: blocked });
        return;
      }
      const handle = vscode.extensions.getExtension<GitExtension>('vscode.git');
      if (!handle) {
        this.releaseGit();
        this.update({
          status: 'unavailable', changes: [],
          message: 'Git changes are unavailable in this workspace. Enable the built-in Git extension to use them.',
        });
        return;
      }
      if (this.gitHandle !== handle || !this.git) {
        this.releaseGit();
        const git = handle.isActive ? handle.exports : await handle.activate();
        if (this.disposed || this.unavailableReason()) {
          return;
        }
        this.gitHandle = handle;
        this.git = git;
        this.enablementListener = git.onDidChangeEnablement(() => {
          this.releaseApi();
          this.publish();
          void this.refresh();
        });
      }
      if (!this.git.enabled) {
        this.releaseApi();
        this.update({ status: 'unavailable', changes: [], message: 'Enable Git in VS Code to see working changes.' });
        return;
      }
      if (!this.api) {
        this.api = this.git.getAPI(1);
        const handleRepositories = (): void => {
          this.syncRepositoryListeners();
          this.publish();
        };
        this.apiDisposables.push(
          this.api.onDidOpenRepository(handleRepositories),
          this.api.onDidCloseRepository(handleRepositories),
          this.api.onDidChangeState(handleRepositories),
        );
      }
      this.syncRepositoryListeners();
      this.publish();
      const api = this.api;
      const results = await Promise.allSettled(this.repositories().map((repository) => repository.status()));
      if (this.disposed || this.api !== api) {
        return;
      }
      this.publish(results.some((result) => result.status === 'rejected')
        ? 'Some Git repositories could not refresh. Showing their last reported changes; check Source Control.'
        : undefined);
    } catch {
      this.releaseApi();
      this.update({
        status: 'unavailable', changes: [],
        message: 'Git changes could not be read. Open Source Control to check the repository, then refresh.',
      });
    }
  }

  private unavailableReason(): string | undefined {
    if (!vscode.workspace.isTrusted) {
      return 'Trust this workspace to enable Git change tracking.';
    }
    if (!vscode.workspace.workspaceFolders?.length) {
      return 'Open a workspace folder to see Git changes.';
    }
    if (!vscode.workspace.getConfiguration('git').get<boolean>('enabled', true)) {
      return 'Enable Git in VS Code to see working changes.';
    }
    return undefined;
  }

  private repositories(): readonly GitRepository[] {
    const folders = vscode.workspace.workspaceFolders ?? [];
    return (this.api?.repositories ?? []).filter((repository) =>
      Boolean(vscode.workspace.getWorkspaceFolder(repository.rootUri))
      || folders.some((folder) => containsUri(repository.rootUri, folder.uri)));
  }

  private syncRepositoryListeners(): void {
    const repositories = new Set(this.repositories());
    for (const [repository, listener] of this.repositoryListeners) {
      if (!repositories.has(repository)) {
        listener.dispose();
        this.repositoryListeners.delete(repository);
      }
    }
    for (const repository of repositories) {
      if (!this.repositoryListeners.has(repository)) {
        this.repositoryListeners.set(repository, repository.state.onDidChange(() => this.publish()));
      }
    }
  }

  private publish(message?: string): void {
    const blocked = this.unavailableReason();
    if (blocked || !this.api || !this.git?.enabled) {
      this.update({ status: 'unavailable', changes: [], message: blocked ?? 'Git changes are currently unavailable.' });
      return;
    }
    const repositories = this.repositories();
    if (!repositories.length) {
      const loading = this.api.state === 'uninitialized';
      this.update({
        status: loading ? 'loading' : 'unavailable', changes: [],
        message: loading ? 'Waiting for Git repositories…' : 'No Git repository is open for this workspace.',
      });
      return;
    }
    this.update({
      status: 'ready',
      changes: normalizeWorkingChanges(repositories.map((repository) => repository.state), workspacePath),
      ...(message ? { message } : {}),
    });
  }

  private update(next: WorkingChangesState): void {
    if (this.disposed || JSON.stringify(next) === JSON.stringify(this.latest)) {
      return;
    }
    this.latest = next;
    this.emitter.fire(next);
  }

  private releaseApi(): void {
    this.api = undefined;
    for (const listener of this.repositoryListeners.values()) {
      listener.dispose();
    }
    this.repositoryListeners.clear();
    while (this.apiDisposables.length) {
      this.apiDisposables.pop()?.dispose();
    }
  }

  private releaseGit(): void {
    this.releaseApi();
    this.enablementListener?.dispose();
    this.enablementListener = undefined;
    this.git = undefined;
    this.gitHandle = undefined;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.releaseGit();
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }
}

function containsUri(parent: vscode.Uri, child: vscode.Uri): boolean {
  if (parent.scheme !== child.scheme || parent.authority !== child.authority) {
    return false;
  }
  const prefix = parent.path.replace(/\/$/, '');
  return child.path === prefix || child.path.startsWith(`${prefix}/`);
}
