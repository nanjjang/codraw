import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeWorkspace } from '../src/analyzer';
import { developmentReviewMarkdown } from '../src/developmentReport';

function fixture() {
  return analyzeWorkspace([
    { path: 'src/user.ts', content: 'export const sourceOnlyMarker = 42;', size: 35 },
    { path: 'src/api.ts', content: "\nimport './user';", size: 17 },
    { path: 'tests/api.test.ts', content: "import '../src/api';", size: 20 },
    { path: 'tests/user.test.ts', content: 'export {};', size: 10 },
  ], { projectName: 'Review project' });
}

test('review notes include directional evidence and separate test heuristics without copying source', () => {
  const result = developmentReviewMarkdown(fixture(), { scope: 'file', paths: ['src/user.ts'] });
  assert.match(result, /Direct dependents \(1\)/);
  assert.match(result, /Indirect dependents \(1\)/);
  assert.match(result, /src\/api.ts:2/);
  assert.match(result, /connected through imports/);
  assert.match(result, /filename match only; relevance unverified/);
  assert.match(result, /Tests were not run/);
  assert.doesNotMatch(result, /sourceOnlyMarker/);
});

test('working review retains rename origins, deleted files, unsaved edits and stale analysis boundaries', () => {
  const result = developmentReviewMarkdown(fixture(), {
    scope: 'changes', paths: ['src/user.ts', 'src/old.ts', 'gone.ts'],
    changes: [{ path: 'src/user.ts', originalPath: 'src/old.ts', staged: true, unstaged: true,
      deleted: false, renamed: true, conflict: true, untracked: false }],
    dirtyPaths: ['src/api.ts'], stale: true,
  });
  assert.match(result, /Not in this analysis \(2\)/);
  assert.match(result, /gone.ts/);
  assert.match(result, /staged, working tree, renamed, conflict/);
  assert.match(result, /Unsaved files/);
  assert.match(result, /workspace has changed since/);
  assert.match(result, /not an analysis of the staged diff/);
  assert.match(result, /Missing results do not mean a change is safe/);
});

test('paths containing Markdown delimiters remain inert inline code', () => {
  const result = developmentReviewMarkdown(fixture(), { scope: 'file', paths: ['evil`[file](command:run)\n# heading.ts'] });
  assert.match(result, /`` evil`\[file\]\(command:run\) # heading.ts ``/);
  assert.doesNotMatch(result, /\n# heading/);
});

test('long reports state the exact number omitted from each section', () => {
  const paths = Array.from({ length: 160 }, (_, i) => `missing-${i}.ts`);
  const result = developmentReviewMarkdown(fixture(), { scope: 'file', paths });
  assert.match(result, /Not in this analysis \(160\)/);
  assert.match(result, /10 additional items/);
});
