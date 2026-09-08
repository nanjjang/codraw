import * as vscode from 'vscode';
import { buildDevelopmentContext } from './developmentModel';
import { developmentReviewMarkdown } from './developmentReport';
import type { RepogramContext } from './repogramContext';
import { workspacePath, workspaceUri } from './workspacePaths';

export type DevelopmentScope = 'file' | 'changes';

export function dirtyWorkspacePaths(): string[] {
  return vscode.workspace.textDocuments.filter((document) => document.isDirty)
    .map((document) => workspacePath(document.uri)).filter((path): path is string => Boolean(path)).sort();
}

export function developmentTargetPath(repogram: RepogramContext, resource?: unknown): string | undefined {
  return resource instanceof vscode.Uri ? workspacePath(resource) : repogram.tracker.current?.path;
}

export async function openDevelopmentSource(repogram: RepogramContext, path: string, line = 1): Promise<void> {
  const snapshot = repogram.service.snapshot;
  if (snapshot && buildDevelopmentContext(snapshot, [path]).seeds.length) {
    await repogram.service.openPath(path, line);
    return;
  }
  // Git can list supported and unsupported files alike. Only its live allow-list
  // can authorize navigation outside the scanned files; deleted paths stay closed.
  const change = repogram.changes.current.changes.find((candidate) => candidate.path === path && !candidate.deleted);
  const uri = change ? workspaceUri(path) : undefined;
  if (!uri) {
    void vscode.window.showWarningMessage('This file is not available in the current analysis or Git changes.');
    return;
  }
  try {
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: true });
  } catch {
    void vscode.window.showWarningMessage(`Repogram could not open ${path}. The file may have moved or been removed.`);
  }
}

export async function copyDevelopmentReview(repogram: RepogramContext, scope: DevelopmentScope, path?: string): Promise<void> {
  const snapshot = await repogram.service.ensure();
  if (!snapshot) {
    return;
  }
  if (scope === 'changes') {
    await repogram.changes.refresh();
  }
  const changes = repogram.changes.current;
  const paths = scope === 'changes'
    ? [...new Set(changes.changes.flatMap((change) => [change.path, ...(change.originalPath ? [change.originalPath] : [])]))]
    : [path ?? repogram.tracker.current?.path].filter((candidate): candidate is string => Boolean(candidate));
  if (!paths.length || (scope === 'changes' && changes.status !== 'ready')) {
    void vscode.window.showInformationMessage(scope === 'changes' ? 'No Git changes are available to review.' : 'Open a workspace source file to review its impact.');
    return;
  }
  const report = developmentReviewMarkdown(snapshot, { scope, paths, changes: changes.changes,
    dirtyPaths: dirtyWorkspacePaths(), stale: repogram.service.isStale });
  try {
    await vscode.env.clipboard.writeText(report);
    void vscode.window.showInformationMessage('Repogram review copied. It includes file paths and static analysis notes.');
  } catch {
    void vscode.window.showErrorMessage('Repogram could not write to the clipboard.');
  }
}

export async function showRelatedTests(repogram: RepogramContext, resource?: unknown): Promise<void> {
  const path = developmentTargetPath(repogram, resource);
  if (!path) {
    void vscode.window.showInformationMessage('Open a workspace source file to find related tests.');
    return;
  }
  const snapshot = await repogram.service.ensure();
  if (!snapshot) {
    return;
  }
  const context = buildDevelopmentContext(snapshot, [path]);
  if (!context.suggestedTests.length) {
    void vscode.window.showInformationMessage('No related tests were found by static imports or filename matching. This is not a coverage result.');
    return;
  }
  const chosen = await vscode.window.showQuickPick(context.suggestedTests.map((test) => ({
    label: test.path,
    description: test.reason === 'dependency' ? 'Connected through imports' : 'Filename match only',
    detail: test.reason === 'dependency' ? 'Inspect this test before deciding what to run.' : 'Relevance is unverified. Inspect the source.',
    path: test.path,
  })), { title: `Tests to inspect for ${path}`, matchOnDescription: true });
  if (chosen) {
    await repogram.service.openPath(chosen.path);
  }
}
