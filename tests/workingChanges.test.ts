import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import type * as vscode from 'vscode';
import type * as WorkingChanges from '../src/workingChanges';

type GitChanges = Parameters<typeof WorkingChanges.normalizeWorkingChanges>[0][number];
type GitChange = GitChanges['indexChanges'][number];

class TestEvent<T> {
  private readonly listeners = new Set<(value: T) => void>();
  readonly event = (listener: (value: T) => void): vscode.Disposable => {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  };
  fire(value: T): void {
    for (const listener of this.listeners) {
      listener(value);
    }
  }
  dispose(): void {
    this.listeners.clear();
  }
  get size(): number {
    return this.listeners.size;
  }
}

function uri(path: string, scheme = 'file', authority = ''): vscode.Uri {
  return { path, scheme, authority } as vscode.Uri;
}

function change(path: string, status: number, original = path): GitChange {
  return { uri: uri(path), originalUri: uri(original), status };
}

function changes(overrides: Partial<GitChanges> = {}): GitChanges {
  return { indexChanges: [], workingTreeChanges: [], mergeChanges: [], ...overrides };
}

function repository(root = '/workspace') {
  const stateEvent = new TestEvent<void>();
  return {
    rootUri: uri(root),
    state: { ...changes(), onDidChange: stateEvent.event },
    stateEvent,
    statusCalls: 0,
    statusError: false,
    status(): Promise<void> {
      this.statusCalls += 1;
      return this.statusError ? Promise.reject(new Error('status failed')) : Promise.resolve();
    },
  };
}

/** Load the compiled host module against a small API double, without VS Code. */
function fixture(options: { trusted?: boolean; available?: boolean } = {}) {
  const trust = new TestEvent<void>();
  const workspaceFolders = new TestEvent<void>();
  const configuration = new TestEvent<{ affectsConfiguration: (section: string) => boolean }>();
  const extensions = new TestEvent<void>();
  const enablement = new TestEvent<boolean>();
  const opened = new TestEvent<ReturnType<typeof repository>>();
  const closed = new TestEvent<ReturnType<typeof repository>>();
  const apiState = new TestEvent<string>();
  const api = {
    state: 'initialized',
    repositories: [repository()],
    onDidChangeState: apiState.event,
    onDidOpenRepository: opened.event,
    onDidCloseRepository: closed.event,
  };
  const git = { enabled: true, onDidChangeEnablement: enablement.event, getAPI: () => api };
  let activationCount = 0;
  const handle = {
    isActive: false,
    exports: git,
    activate: () => {
      activationCount += 1;
      return Promise.resolve(git);
    },
  };
  const workspace = {
    isTrusted: options.trusted ?? true,
    gitEnabled: true,
    workspaceFolders: [{ name: 'workspace', uri: uri('/workspace') }],
    onDidGrantWorkspaceTrust: trust.event,
    onDidChangeWorkspaceFolders: workspaceFolders.event,
    onDidChangeConfiguration: configuration.event,
    getConfiguration: () => ({ get: () => workspace.gitEnabled }),
    getWorkspaceFolder: (resource: vscode.Uri) => workspace.workspaceFolders.find((folder) =>
      resource.scheme === folder.uri.scheme && resource.authority === folder.uri.authority
      && (resource.path === folder.uri.path || resource.path.startsWith(`${folder.uri.path}/`))),
  };
  const pathForUri = (resource: vscode.Uri): string | undefined => {
    const folder = workspace.getWorkspaceFolder(resource);
    if (!folder) {
      return undefined;
    }
    const relative = resource.path.slice(folder.uri.path.length + 1);
    return workspace.workspaceFolders.length > 1 ? `${folder.name}/${relative}` : relative;
  };
  const mockVscode = {
    EventEmitter: TestEvent,
    workspace,
    extensions: {
      getExtension: () => options.available === false ? undefined : handle,
      onDidChange: extensions.event,
    },
  };
  const module = { exports: {} as typeof WorkingChanges };
  runInNewContext(readFileSync('dist-test/src/workingChanges.js', 'utf8'), {
    exports: module.exports,
    require: (name: string): unknown => {
      if (name === 'vscode') {
        return mockVscode;
      }
      if (name === './workspacePaths') {
        return { workspacePath: pathForUri };
      }
      throw new Error(`Unexpected dependency: ${name}`);
    },
  });
  return {
    ...module.exports, workspace, git, api, trust, workspaceFolders, configuration,
    extensions, enablement, opened, closed, apiState, pathForUri,
    get activationCount() { return activationCount; },
  };
}

test('Git groups merge staged and unstaged edits and include either untracked setting', () => {
  const host = fixture();
  const result = host.normalizeWorkingChanges([changes({
    indexChanges: [change('/workspace/src/main.ts', 0)],
    workingTreeChanges: [change('/workspace/src/main.ts', 5), change('/workspace/b.ts', 7), change('/workspace/ignored.ts', 8)],
    untrackedChanges: [change('/workspace/a.ts', 7), change('/workspace/b.ts', 7)],
  })], host.pathForUri);

  assert.deepEqual([...result].map((row) => ({ ...row })), [
    { path: 'a.ts', staged: false, unstaged: true, untracked: true, deleted: false, renamed: false, conflict: false },
    { path: 'b.ts', staged: false, unstaged: true, untracked: true, deleted: false, renamed: false, conflict: false },
    { path: 'src/main.ts', staged: true, unstaged: true, untracked: false, deleted: false, renamed: false, conflict: false },
  ]);
});

test('renames preserve old identity, copies stay copies, and deleted files remain visible', () => {
  const host = fixture();
  const result = host.normalizeWorkingChanges([changes({
    indexChanges: [
      change('/workspace/new.ts', 3, '/workspace/old.ts'),
      change('/workspace/copy.ts', 4, '/workspace/original.ts'),
      change('/workspace/deleted.ts', 2),
    ],
    workingTreeChanges: [change('/workspace/new.ts', 5), change('/workspace/removed.ts', 6)],
  })], host.pathForUri);
  const rename = result.find((row) => row.path === 'new.ts');
  assert.equal(rename?.originalPath, 'old.ts');
  assert.equal(rename.renamed, true);
  assert.equal(rename.staged && rename.unstaged, true);
  assert.equal(result.find((row) => row.path === 'copy.ts')?.renamed, false);
  assert.equal(result.filter((row) => row.deleted).length, 2);
});

test('all unresolved merge states surface conflicts without calling them staged', () => {
  const host = fixture();
  const result = host.normalizeWorkingChanges([changes({
    mergeChanges: Array.from({ length: 7 }, (_, index) => change(`/workspace/conflict-${index}.ts`, index + 12)),
  })], host.pathForUri);
  assert.equal(result.length, 7);
  assert.ok(result.every((row) => row.conflict && row.unstaged && !row.staged));
  assert.equal(result.find((row) => row.path === 'conflict-5.ts')?.deleted, true);
});

test('changes outside workspace are omitted, but moving a source file out is a deletion', () => {
  const host = fixture();
  const result = host.normalizeWorkingChanges([changes({
    indexChanges: [change('/outside/a.ts', 0), change('/outside/moved.ts', 3, '/workspace/old.ts')],
  })], host.pathForUri);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.path, 'old.ts');
  assert.equal(result[0]?.renamed, true);
  assert.equal(result[0]?.deleted, true);
});

test('Git never activates in an untrusted workspace and connects after trust is granted', async () => {
  const host = fixture({ trusted: false });
  const tracker = new host.WorkingChangesTracker();
  await tracker.refresh();
  assert.equal(host.activationCount, 0);
  assert.equal(tracker.current.status, 'unavailable');
  host.workspace.isTrusted = true;
  host.trust.fire();
  await tracker.refresh();
  assert.equal(host.activationCount, 1);
  assert.equal(tracker.current.status, 'ready');
  tracker.dispose();
});

test('missing Git is unavailable and an empty initialized repository is ready', async () => {
  const missing = fixture({ available: false });
  const absent = new missing.WorkingChangesTracker();
  await absent.refresh();
  assert.equal(absent.current.status, 'unavailable');
  absent.dispose();

  const host = fixture();
  const tracker = new host.WorkingChangesTracker();
  await tracker.refresh();
  assert.equal(tracker.current.status, 'ready');
  assert.equal(tracker.current.changes.length, 0);
  host.api.repositories = [];
  host.apiState.fire('initialized');
  assert.equal(tracker.current.status, 'unavailable');
  host.api.state = 'uninitialized';
  host.apiState.fire('uninitialized');
  assert.equal(tracker.current.status, 'loading');
  tracker.dispose();
});

test('repository status events update immediately, and close and dispose remove listeners', async () => {
  const host = fixture();
  const tracker = new host.WorkingChangesTracker();
  await tracker.refresh();
  const repo = host.api.repositories[0];
  assert.ok(repo);
  const statusCalls = repo.statusCalls;
  repo.state.workingTreeChanges = [change('/workspace/main.ts', 5)];
  repo.stateEvent.fire();
  assert.equal(tracker.current.changes[0]?.path, 'main.ts');
  assert.equal(repo.statusCalls, statusCalls, 'status events must not start another Git status process');
  host.api.repositories = [];
  host.closed.fire(repo);
  assert.equal(repo.stateEvent.size, 0);
  assert.equal(tracker.current.status, 'unavailable');
  host.api.repositories = [repo];
  host.opened.fire(repo);
  assert.equal(repo.stateEvent.size, 1);
  tracker.dispose();
  assert.equal(repo.stateEvent.size, 0);
  assert.equal(host.opened.size, 0);
  assert.equal(host.enablement.size, 0);
  assert.equal(host.workspaceFolders.size, 0);
});

test('multi-root changes retain folder identities and parent repositories only include workspace files', async () => {
  const host = fixture();
  host.workspace.workspaceFolders = [
    { name: 'api', uri: uri('/workspace/api') },
    { name: 'web', uri: uri('/workspace/web') },
  ];
  const repo = host.api.repositories[0];
  assert.ok(repo);
  repo.state.workingTreeChanges = [
    change('/workspace/api/src/main.ts', 5),
    change('/workspace/web/src/main.ts', 5),
    change('/workspace/unopened/main.ts', 5),
  ];
  const tracker = new host.WorkingChangesTracker();
  await tracker.refresh();
  assert.equal(tracker.current.status, 'ready');
  assert.deepEqual([...tracker.current.changes].map((row) => row.path), ['api/src/main.ts', 'web/src/main.ts']);
  tracker.dispose();
});

test('Git disablement clears rows, re-enablement reconnects, and refresh failures are visible', async () => {
  const host = fixture();
  const tracker = new host.WorkingChangesTracker();
  await tracker.refresh();
  host.git.enabled = false;
  host.enablement.fire(false);
  await tracker.refresh();
  assert.equal(tracker.current.status, 'unavailable');
  assert.equal(tracker.current.changes.length, 0);
  host.git.enabled = true;
  host.enablement.fire(true);
  await tracker.refresh();
  assert.equal(tracker.current.status, 'ready');
  const repo = host.api.repositories[0];
  assert.ok(repo);
  repo.statusError = true;
  await tracker.refresh();
  assert.equal(tracker.current.status, 'ready');
  assert.match(tracker.current.message ?? '', /could not refresh/);
  tracker.dispose();
});
