import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import * as analyzer from '../src/analyzer';
import type * as ActiveEditor from '../src/activeEditor';

function fixture() {
  type Editor = { document: { uri: { path: string } } };
  let activeListener: (editor: Editor | undefined) => void = () => {};
  let configListener: (event: { affectsConfiguration: () => boolean }) => void = () => {};
  const source: Editor = { document: { uri: { path: 'api/src/main.ts' } } };
  const window = { activeTextEditor: source as Editor | undefined, visibleTextEditors: [source],
    onDidChangeActiveTextEditor: (fn: typeof activeListener) => { activeListener = fn; return { dispose() {} }; } };
  let following = true;
  const workspace = {
    getConfiguration: () => ({ get: () => following }), getWorkspaceFolder: () => ({}),
    onDidChangeConfiguration: (fn: typeof configListener) => { configListener = fn; return { dispose() {} }; },
  };
  const module = { exports: {} as typeof ActiveEditor };
  runInNewContext(readFileSync('dist-test/src/activeEditor.js', 'utf8'), {
    exports: module.exports,
    require: (name: string): unknown => {
      if (name === './analyzer') return analyzer;
      if (name === './workspacePaths') return { workspacePath: (uri: { path: string }) => uri.path };
      if (name === 'vscode') return { window, workspace, EventEmitter: class {
        event = () => ({ dispose() {} }); fire() {} dispose() {}
      } };
      throw new Error(`Unexpected module ${name}`);
    },
  });
  const tracker = new module.exports.ActiveEditorTracker(() => ['api']);
  return { tracker, window, source,
    activate(editor: Editor | undefined) { window.activeTextEditor = editor; activeListener(editor); },
    follow(enabled: boolean) { following = enabled; configListener({ affectsConfiguration: () => true }); },
  };
}

test('editor context uses the scanner identity and survives focusing a diagram beside visible source', () => {
  const host = fixture();
  assert.equal(host.tracker.current?.path, 'api/src/main.ts');
  assert.equal(host.tracker.current?.structureNodeId, 'structure:api%2Fsrc%2Fmain.ts');
  host.activate(undefined);
  assert.equal(host.tracker.current?.path, 'api/src/main.ts');
  host.tracker.refresh();
  assert.equal(host.tracker.current?.path, 'api/src/main.ts');
  host.tracker.dispose();
});

test('closing the last source editor clears context instead of retaining a stale file', () => {
  const host = fixture();
  host.window.visibleTextEditors = [];
  host.activate(undefined);
  assert.equal(host.tracker.current, undefined);
  host.tracker.dispose();
});

test('disabling follow-editor still clears the context when a source editor is visible', () => {
  const host = fixture();
  host.follow(false);
  assert.equal(host.tracker.current, undefined);
  host.follow(true);
  const current = () => host.tracker.current;
  assert.equal(current()?.path, 'api/src/main.ts');
  host.tracker.dispose();
});
