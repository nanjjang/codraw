import * as vscode from 'vscode';
import type { RepogramContext } from './repogramContext';
import type { ProjectSnapshot } from './model';
import { RepogramPanel } from './panel';
import { iconSprite } from './icons';
import { bundleUri, contentSecurityPolicy, createNonce, webviewOptionsFor } from './webviewHtml';
import { copyDevelopmentReview, dirtyWorkspacePaths, openDevelopmentSource, type DevelopmentScope } from './developmentActions';

type OverviewMessage =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'rendered'; revision: number }
  | { type: 'openSource'; nodeId: string }
  | { type: 'openDevelopmentSource'; path: string; line?: number }
  | { type: 'copyDevelopmentReview'; scope: DevelopmentScope; path?: string }
  | { type: 'openDiagram'; nodeId?: string };

/**
 * The activity bar view.
 *
 * Registering a webview view is what removes the Command Palette step: opening
 * the container activates the extension and resolves this provider, so the list
 * is on screen without anything being run first.
 */
export class RepogramOverviewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'repogram.overview';

  private view: vscode.WebviewView | undefined;
  private ready = false;
  private renderedRevision: number | undefined;
  private pendingFocus: { scope: DevelopmentScope; path?: string } | undefined;
  private developmentStateKey = '';

  constructor(private readonly repogram: RepogramContext) {}

  get renderReady(): boolean {
    return Boolean(this.repogram.service.snapshot && this.renderedRevision === this.repogram.service.snapshot.revision);
  }

  async revealDevelopment(scope: DevelopmentScope, path?: string): Promise<void> {
    this.pendingFocus = { scope, ...(path ? { path } : {}) };
    await vscode.commands.executeCommand('repogram.overview.focus');
    await this.postFocus();
  }

  private async postFocus(): Promise<void> {
    if (this.ready && this.pendingFocus && this.view) {
      const focus = this.pendingFocus;
      if (await this.view.webview.postMessage({ type: 'focusDevelopment', ...focus })) {
        this.pendingFocus = undefined;
      }
    }
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.ready = false;
    this.developmentStateKey = '';
    view.webview.options = webviewOptionsFor(this.repogram.extension);

    // Moving the view between containers disposes and resolves it again, so the
    // subscriptions belong to this resolution rather than to the extension.
    const disposables: vscode.Disposable[] = [];

    view.webview.onDidReceiveMessage(
      (value: unknown) => this.handleMessage(value),
      undefined,
      disposables,
    );

    this.repogram.changes.onDidChange(() => { void this.postDevelopmentState(); }, undefined, disposables);
    vscode.workspace.onDidChangeTextDocument(() => { void this.postDevelopmentState(); }, undefined, disposables);
    vscode.workspace.onDidSaveTextDocument(() => { void this.postDevelopmentState(); }, undefined, disposables);
    vscode.workspace.onDidCloseTextDocument(() => { void this.postDevelopmentState(); }, undefined, disposables);

    this.repogram.tracker.onDidChange(
      (active) => {
        void view.webview.postMessage({ type: 'activeContext', active: active ?? null });
      },
      undefined,
      disposables,
    );

    this.repogram.service.onDidChange(
      (event) => {
        if (event.type === 'started') {
          void view.webview.postMessage({ type: 'analysisStarted', requestId: event.requestId });
        } else if (event.type === 'snapshot') {
          void this.post(event.snapshot);
        } else if (event.type === 'error') {
          void view.webview.postMessage({ type: 'analysisError', message: event.message });
        } else if (view.visible && vscode.workspace.getConfiguration('repogram').get<boolean>('autoRefresh', true)) {
          void this.repogram.service.refresh();
        } else {
          void view.webview.postMessage({ type: 'analysisStale' });
        }
        void this.postDevelopmentState();
      },
      undefined,
      disposables,
    );

    view.onDidChangeVisibility(
      () => {
        const snapshot = this.repogram.service.snapshot;
        if (view.visible && snapshot) {
          void this.post(snapshot);
          if (this.repogram.service.isStale && vscode.workspace.getConfiguration('repogram').get<boolean>('autoRefresh', true)) {
            void this.repogram.service.refresh();
          }
        }
      },
      undefined,
      disposables,
    );

    view.onDidDispose(() => {
      while (disposables.length) {
        disposables.pop()?.dispose();
      }
      if (this.view === view) {
        this.view = undefined;
        this.ready = false;
        this.renderedRevision = undefined;
      }
    });

    // Opening the container is the request; nothing else has to ask for it.
    view.webview.html = this.getHtml(view.webview);
    void this.repogram.service.ensure();
    void this.repogram.changes.refresh();
  }

  private async post(snapshot: ProjectSnapshot): Promise<void> {
    await this.view?.webview.postMessage({
      type: 'snapshot',
      requestId: snapshot.revision,
      snapshot,
      active: this.repogram.tracker.current ?? null,
    });
    await this.postDevelopmentState();
  }

  private async postDevelopmentState(): Promise<void> {
    const state = {
      type: 'developmentState',
      changes: this.repogram.changes.current,
      dirtyPaths: dirtyWorkspacePaths(),
      stale: this.repogram.service.isStale,
    };
    const key = JSON.stringify(state);
    if (key === this.developmentStateKey || !this.ready) return;
    if (await this.view?.webview.postMessage(state)) this.developmentStateKey = key;
  }

  private handleMessage(value: unknown): void {
    const message = parseOverviewMessage(value);
    if (!message) {
      return;
    }
    if (message.type === 'ready') {
      this.ready = true;
      const snapshot = this.repogram.service.snapshot;
      if (snapshot) {
        void this.post(snapshot);
      } else {
        void this.repogram.service.ensure();
      }
      void this.postDevelopmentState();
      void this.postFocus();
    } else if (message.type === 'refresh') {
      void this.repogram.service.refresh();
      void this.repogram.changes.refresh();
    } else if (message.type === 'rendered') {
      this.renderedRevision = message.revision;
    } else if (message.type === 'openDevelopmentSource') {
      void openDevelopmentSource(this.repogram, message.path, message.line);
    } else if (message.type === 'copyDevelopmentReview') {
      void copyDevelopmentReview(this.repogram, message.scope, message.path);
    } else if (message.type === 'openSource') {
      void this.repogram.service.openSource(message.nodeId);
    } else if (message.type === 'openDiagram') {
      if (message.nodeId) {
        RepogramPanel.revealNode(this.repogram, message.nodeId);
      } else {
        RepogramPanel.createOrShow(this.repogram);
      }
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = createNonce();
    const scriptUri = bundleUri(this.repogram.extension, webview, 'overview.js');
    const styleUri = bundleUri(this.repogram.extension, webview, 'overview.css');
    const csp = contentSecurityPolicy(webview, nonce);

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri}">
  <title>Repogram</title>
</head>
<body>
  ${iconSprite()}
  <div class="overview">
    <header class="ov-header">
      <div class="ov-title">
        <span id="ov-project" class="ov-project">Repogram</span>
        <button id="ov-open" class="ov-header-action" type="button" title="Open the full workspace diagram">Open diagram</button>
        <button id="ov-refresh" class="ov-icon" type="button" aria-label="Re-analyze workspace" title="Re-analyze the workspace">&#8635;</button>
      </div>
      <div id="ov-summary" class="ov-summary">Preparing workspace analysis…</div>
    </header>
    <nav class="ov-tabs" role="tablist" aria-label="Sidebar tool">
      <button id="ov-tab-work" class="ov-tab" type="button" role="tab" aria-controls="ov-work-view" data-view="work">Work</button>
      <button id="ov-tab-map" class="ov-tab" type="button" role="tab" data-view="map">Connections</button>
      <button id="ov-tab-checks" class="ov-tab" type="button" role="tab" data-view="checks">Review <span id="ov-check-count" class="ov-tab-count"></span></button>
    </nav>
    <main id="ov-content" class="ov-content">
      <section id="ov-work-view" class="ov-view" role="tabpanel" aria-labelledby="ov-tab-work"></section>
      <section id="ov-map-view" class="ov-view" role="tabpanel" aria-labelledby="ov-tab-map">
        <div id="ov-current" class="ov-current"></div>
        <div class="ov-map-toolbar">
          <div class="ov-segment" role="group" aria-label="Relationship map type">
            <button id="ov-code" type="button" data-area="code">Code</button>
            <button id="ov-data" type="button" data-area="data">Data</button>
          </div>
          <button id="ov-follow" class="ov-follow" type="button" aria-pressed="true" title="Follow the active editor">Follows editor</button>
        </div>
        <div class="ov-picker">
          <label for="ov-search">Choose the item at the center</label>
          <input id="ov-search" type="search" placeholder="Find a module" autocomplete="off">
          <div id="ov-suggestions" class="ov-suggestions" role="listbox" hidden></div>
        </div>
        <div class="ov-map-directions" aria-hidden="true"><span>Used by</span><span>Selected</span><span>Uses</span></div>
        <div id="ov-map" class="ov-map" aria-live="polite"></div>
        <div id="ov-focus-card" class="ov-focus-card"></div>
      </section>
      <section id="ov-checks-view" class="ov-view" role="tabpanel" aria-labelledby="ov-tab-checks" hidden>
        <div class="ov-review-intro">
          <strong>Things worth a quick look</strong>
          <span>These are static-analysis hints, not confirmed code problems. Open an item to inspect its source.</span>
        </div>
        <div id="ov-checks" class="ov-checks"></div>
      </section>
      <div id="ov-state" class="ov-state" role="status">Analyzing workspace…</div>
    </main>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function parseOverviewMessage(value: unknown): OverviewMessage | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.type === 'ready' || candidate.type === 'refresh') {
    return { type: candidate.type };
  }
  if (candidate.type === 'rendered' && typeof candidate.revision === 'number' && Number.isSafeInteger(candidate.revision)) {
    return { type: 'rendered', revision: candidate.revision };
  }
  if (candidate.type === 'openSource' && typeof candidate.nodeId === 'string' && candidate.nodeId.length < 1000) {
    return { type: 'openSource', nodeId: candidate.nodeId };
  }
  if (candidate.type === 'openDevelopmentSource' && typeof candidate.path === 'string' && candidate.path.length < 4096) {
    if (candidate.line !== undefined && (typeof candidate.line !== 'number' || !Number.isSafeInteger(candidate.line) || candidate.line < 1)) return undefined;
    return { type: 'openDevelopmentSource', path: candidate.path, ...(typeof candidate.line === 'number' ? { line: candidate.line } : {}) };
  }
  if (candidate.type === 'copyDevelopmentReview' && (candidate.scope === 'file' || candidate.scope === 'changes')) {
    if (candidate.path !== undefined && (typeof candidate.path !== 'string' || candidate.path.length >= 4096)) {
      return undefined;
    }
    return { type: 'copyDevelopmentReview', scope: candidate.scope, ...(typeof candidate.path === 'string' ? { path: candidate.path } : {}) };
  }
  if (candidate.type === 'openDiagram') {
    return typeof candidate.nodeId === 'string' && candidate.nodeId.length < 1000
      ? { type: 'openDiagram', nodeId: candidate.nodeId }
      : { type: 'openDiagram' };
  }
  return undefined;
}
