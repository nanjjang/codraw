import * as vscode from 'vscode';

/** The scanner, editor tracker and Git view must use the same file identity. */
export function workspacePath(uri: vscode.Uri): string | undefined {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) {
    return undefined;
  }
  const relative = vscode.workspace.asRelativePath(uri, false).replaceAll('\\', '/');
  return (vscode.workspace.workspaceFolders?.length ?? 0) > 1
    ? `${folder.name}/${relative}`
    : relative;
}

/** Resolves a known workspace path, never a URI supplied by a webview. */
export function workspaceUri(path: string): vscode.Uri | undefined {
  if (!path || path.includes('\\') || path.split('/').some((part) => !part || part === '.' || part === '..')) {
    return undefined;
  }
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 1 && folders[0]) {
    return vscode.Uri.joinPath(folders[0].uri, path);
  }
  const folder = folders.find((candidate) => path.startsWith(`${candidate.name}/`));
  return folder ? vscode.Uri.joinPath(folder.uri, path.slice(folder.name.length + 1)) : undefined;
}
