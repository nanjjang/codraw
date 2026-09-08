import * as vscode from 'vscode';
import { ActiveEditorTracker } from './activeEditor';
import { AnalysisService } from './analysisService';
import type { RepogramContext } from './repogramContext';
import { RepogramOverviewProvider } from './overviewView';
import { RepogramPanel } from './panel';
import { exportSchemaDocumentation } from './schemaExport';
import { WorkingChangesTracker } from './workingChanges';
import { copyDevelopmentReview, developmentTargetPath, showRelatedTests } from './developmentActions';

export interface RepogramApi {
  getStatus(): {
    panelOpen: boolean;
    analysisReady: boolean;
    renderReady: boolean;
    overviewReady: boolean;
    gitStatus: string;
    changedFiles: number;
    projectName?: string;
    files?: number;
    modules?: number;
    flowUnits?: number;
    databaseEntities?: number;
    activePath?: string;
    activeModuleNodeId?: string;
  };
}

export function activate(context: vscode.ExtensionContext): RepogramApi {
  const service = new AnalysisService();
  // Which module a file belongs to depends on where its project begins, and
  // only the analysis knows that, so the tracker reads it from the latest one.
  const tracker = new ActiveEditorTracker(() => service.snapshot?.projectRoots ?? []);
  const changes = new WorkingChangesTracker();
  const repogram: RepogramContext = { extension: context, service, tracker, changes };
  const overview = new RepogramOverviewProvider(repogram);

  context.subscriptions.push(
    service,
    tracker,
    changes,
    service.onDidChange((event) => {
      if (event.type === 'snapshot') {
        tracker.refresh();
      }
    }),
    vscode.window.registerWebviewViewProvider(RepogramOverviewProvider.viewType, overview, {
      // The sidebar list is cheap to keep alive and expensive to rebuild, and
      // holding it means switching away and back is instant.
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('repogram.open', () => {
      RepogramPanel.createOrShow(repogram);
    }),
    vscode.commands.registerCommand('repogram.refresh', async () => {
      await RepogramPanel.refreshCurrent(repogram);
    }),
    vscode.commands.registerCommand('repogram.exportSchemaDocs', async () => {
      await exportSchemaDocumentation(repogram);
    }),
    vscode.commands.registerCommand('repogram.showFileImpact', async (resource?: unknown) => {
      const path = developmentTargetPath(repogram, resource);
      await overview.revealDevelopment('file', path);
    }),
    vscode.commands.registerCommand('repogram.reviewChanges', async () => {
      await overview.revealDevelopment('changes');
      await changes.refresh();
    }),
    vscode.commands.registerCommand('repogram.findRelatedTests', async (resource?: unknown) => {
      await showRelatedTests(repogram, resource);
    }),
    vscode.commands.registerCommand('repogram.copyChangeReview', async () => {
      await copyDevelopmentReview(repogram, 'changes');
    }),
    vscode.window.registerWebviewPanelSerializer(RepogramPanel.viewType, {
      deserializeWebviewPanel(panel: vscode.WebviewPanel): Promise<void> {
        RepogramPanel.revive(repogram, panel);
        return Promise.resolve();
      },
    }),
  );

  return {
    getStatus: () => {
      const snapshot = service.snapshot;
      const panel = RepogramPanel.getStatus(snapshot);
      const active = tracker.current;
      return {
        panelOpen: panel.panelOpen,
        analysisReady: Boolean(snapshot),
        renderReady: panel.renderReady,
        overviewReady: overview.renderReady,
        gitStatus: changes.current.status,
        changedFiles: changes.current.changes.length,
        ...(snapshot ? {
          projectName: snapshot.projectName,
          files: snapshot.stats.files,
          modules: snapshot.stats.modules,
          flowUnits: snapshot.stats.flowUnits,
          databaseEntities: snapshot.stats.databaseEntities,
        } : {}),
        ...(active ? {
          activePath: active.path,
          activeModuleNodeId: active.moduleNodeId,
        } : {}),
      };
    },
  };
}

export function deactivate(): void {
  // VS Code disposes registered commands, views and panels through their subscriptions.
}
