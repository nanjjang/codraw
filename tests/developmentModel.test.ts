import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeWorkspace, structureNodeIdForPath } from '../src/analyzer';
import { buildDevelopmentContext, getDevelopmentEvidence } from '../src/developmentModel';
import type { FileDependency, ProjectSnapshot, WorkspaceFile } from '../src/model';

function file(path: string, content = 'export {};'): WorkspaceFile {
  return { path, content, size: content.length };
}

function edge(from: string, to: string, line = 1): FileDependency {
  return { from, to, line, confidence: 'inferred' };
}

function snapshot(
  paths: readonly string[],
  fileDependencies: FileDependency[],
  testPaths: readonly string[] = [],
): ProjectSnapshot {
  const base = analyzeWorkspace([], { projectName: 'development', revision: 1 });
  const tests = new Set(testPaths);
  return {
    ...base,
    fileDependencies,
    structure: {
      ...base.structure,
      children: paths.map((path) => ({
        id: structureNodeIdForPath(path), label: path, path, kind: 'file',
        source: { file: path, line: 1 }, role: tests.has(path) ? 'test' : 'source',
        children: [],
      })),
    },
  };
}

test('analyzer serializes same-module imports with first declaration evidence, without self or unresolved edges', () => {
  const result = analyzeWorkspace([
    file('src/a.ts', "// Heading\n\nimport { b } from './b';\nimport './b';\nimport './a';\nimport './missing';\nimport 'external';"),
    file('src/b.ts', 'export const b = 1;'),
  ], { projectName: 'same module' });
  assert.equal(result.architecture.edges.filter((item) => item.kind === 'imports').length, 0);
  assert.deepEqual(result.fileDependencies, [edge('src/a.ts', 'src/b.ts', 3)]);
  assert.ok(result.diagnostics.some((item) => item.code === 'UNRESOLVED_IMPORT'));
  const restored = JSON.parse(JSON.stringify(result)) as ProjectSnapshot;
  const context = buildDevelopmentContext(restored, ['src/b.ts']);
  assert.equal(context.directDependents[0]?.nodeId, 'structure:src%2Fa.ts');
  assert.deepEqual(context.directDependents[0]?.source, { file: 'src/a.ts', line: 3 });
});

test('emitted JavaScript import names can reach TypeScript sources while existing JavaScript wins', () => {
  const result = analyzeWorkspace([
    file('src/user.ts'),
    file('src/client.ts'),
    file('src/client.js'),
    file('tests/user.test.ts', "import '../src/user.js';\nimport '../src/client.js';"),
  ], { projectName: 'typescript' });
  assert.deepEqual(result.fileDependencies, [
    edge('tests/user.test.ts', 'src/client.js', 2),
    edge('tests/user.test.ts', 'src/user.ts'),
  ]);
  assert.equal(buildDevelopmentContext(result, ['src/user.ts']).suggestedTests[0]?.reason, 'dependency');
});

test('impact traverses importers, direct dependencies point forward, and evidence reconstructs a full chain', () => {
  const value = snapshot(
    ['src/domain.ts', 'src/api.ts', 'src/ui.ts', 'tests/ui.test.ts', 'src/types.ts', 'src/unrelated.ts'],
    [
      edge('src/domain.ts', 'src/types.ts', 4), edge('src/api.ts', 'src/domain.ts', 8),
      edge('src/ui.ts', 'src/api.ts', 12), edge('tests/ui.test.ts', 'src/ui.ts', 2),
    ],
    ['tests/ui.test.ts'],
  );
  const result = buildDevelopmentContext(value, ['src/domain.ts']);
  assert.deepEqual(result.directDependents.map((item) => item.path), ['src/api.ts']);
  assert.deepEqual(result.transitiveDependents.map((item) => [item.path, item.distance]), [
    ['src/ui.ts', 2], ['tests/ui.test.ts', 3],
  ]);
  assert.deepEqual(result.directDependencies.map((item) => item.path), ['src/types.ts']);
  assert.deepEqual(getDevelopmentEvidence(result, 'tests/ui.test.ts'), [
    edge('tests/ui.test.ts', 'src/ui.ts', 2), edge('src/ui.ts', 'src/api.ts', 12),
    edge('src/api.ts', 'src/domain.ts', 8),
  ]);
  assert.deepEqual(getDevelopmentEvidence(result, 'src/types.ts'), [edge('src/domain.ts', 'src/types.ts', 4)]);
  assert.deepEqual(result.suggestedTests.map((item) => [item.path, item.reason]), [['tests/ui.test.ts', 'dependency']]);
});

test('diamonds choose deterministic shortest evidence and cycles exclude all seeds', () => {
  const edges = [
    edge('a.ts', 'seed.ts'), edge('b.ts', 'seed.ts'), edge('diamond.ts', 'b.ts', 8),
    edge('diamond.ts', 'a.ts', 3), edge('seed.ts', 'diamond.ts'), edge('a.ts', 'a.ts'),
    edge('nearest.ts', 'diamond.ts'), edge('diamond.ts', 'second.ts', 10),
  ];
  const value = snapshot(['seed.ts', 'second.ts', 'a.ts', 'b.ts', 'diamond.ts', 'nearest.ts'], edges);
  const single = buildDevelopmentContext(value, ['seed.ts']);
  assert.deepEqual(getDevelopmentEvidence(single, 'diamond.ts'), [edge('diamond.ts', 'a.ts', 3), edge('a.ts', 'seed.ts')]);
  assert.deepEqual(buildDevelopmentContext({ ...value, fileDependencies: [...edges].reverse() }, ['seed.ts']), single);
  const multiple = buildDevelopmentContext(value, ['seed.ts', 'second.ts', 'seed.ts']);
  const diamond = multiple.directDependents.find((item) => item.path === 'diamond.ts');
  assert.equal(diamond?.seedPath, 'second.ts');
  assert.equal(multiple.transitiveDependents.find((item) => item.path === 'nearest.ts')?.distance, 2);
  assert.ok(![...multiple.directDependents, ...multiple.transitiveDependents].some((item) => item.path === 'seed.ts' || item.path === 'second.ts'));
});

test('duplicate edges prefer exact evidence then earliest import, dangling and unresolved edges never invent impact', () => {
  const value = snapshot(['src/a.ts', 'src/b.ts', 'src/c.ts'], [
    edge('src/b.ts', 'src/a.ts', 2), { ...edge('src/b.ts', 'src/a.ts', 5), confidence: 'exact' },
    { ...edge('src/b.ts', 'src/a.ts', 4), confidence: 'exact' },
    { ...edge('src/c.ts', 'src/a.ts'), confidence: 'unresolved' }, edge('gone.ts', 'src/a.ts'),
  ]);
  const result = buildDevelopmentContext(value, ['./src/a.ts', 'src\\a.ts', 'deleted.ts', 'deleted.ts']);
  assert.equal(result.seeds.length, 1);
  assert.equal(result.directDependents.length, 1);
  assert.equal(result.directDependents[0]?.via.confidence, 'exact');
  assert.equal(result.directDependents[0]?.via.line, 4);
  assert.deepEqual(result.unindexedPaths, ['deleted.ts']);
  assert.deepEqual(getDevelopmentEvidence(result, 'unknown.ts'), []);
  assert.equal(buildDevelopmentContext({ ...value, fileDependencies: undefined }, ['src/a.ts']).directDependents.length, 0);
});

test('test suggestions distinguish dependency evidence from exact basename heuristics within the nearest package', () => {
  const result = analyzeWorkspace([
    file('packages/one/package.json', '{}'), file('packages/two/package.json', '{}'),
    file('packages/one/src/user.ts'), file('packages/one/src/contest.ts'),
    file('packages/one/tests/user.test.ts'), file('packages/one/tests/test_user.py', 'pass'),
    file('packages/one/tests/UserTests.java', 'class UserTests {}'),
    file('packages/one/tests/userSettings.test.ts'),
    file('packages/one/tests/integration.test.ts', "import '../src/user';"),
    file('packages/one/tests/fixtures/user.test.ts'), file('packages/one/tests/user.json', '{}'),
    file('packages/two/tests/user.test.ts'),
    file('packages/one/nested/package.json', '{}'), file('packages/one/nested/tests/user.test.ts'),
  ], { projectName: 'monorepo' });
  const context = buildDevelopmentContext(result, ['packages/one/src/user.ts']);
  assert.deepEqual(context.suggestedTests.map((item) => [item.path, item.reason]), [
    ['packages/one/tests/integration.test.ts', 'dependency'],
    ['packages/one/tests/test_user.py', 'filename'],
    ['packages/one/tests/user.test.ts', 'filename'],
    ['packages/one/tests/UserTests.java', 'filename'],
  ]);
  assert.deepEqual(getDevelopmentEvidence(context, 'packages/one/tests/user.test.ts'), []);
  assert.ok(context.suggestedTests.every((item) => item.path !== 'packages/one/src/contest.ts'));
});

test('a filename match with dependency evidence is listed only once and changed test files are not suggested as dependents', () => {
  const result = analyzeWorkspace([
    file('src/user.ts'), file('tests/user.test.ts', "import '../src/user';"),
  ], { projectName: 'tests' });
  const context = buildDevelopmentContext(result, ['src/user.ts']);
  assert.equal(context.suggestedTests.length, 1);
  assert.equal(context.suggestedTests[0]?.reason, 'dependency');
  assert.equal(buildDevelopmentContext(result, ['src/user.ts', 'tests/user.test.ts']).suggestedTests.length, 0);
});

test('Go package evidence points to the individual import line', () => {
  const result = analyzeWorkspace([
    file('go.mod', 'module example.com/app'),
    file('store/item.go', 'package store\ntype Item struct {}'),
    file('main.go', 'package main\n\nimport (\n "fmt"\n "example.com/app/store"\n)\n'),
  ], { projectName: 'go' });
  assert.deepEqual(result.fileDependencies, [edge('main.go', 'store/item.go', 5)]);
});

test('ten thousand files traverse iteratively and only expand requested evidence', () => {
  const paths = Array.from({ length: 10_000 }, (_, index) => `src/file${index}.ts`);
  const dependencies = paths.slice(1).map((path, index) => edge(path, paths[index] ?? ''));
  const result = buildDevelopmentContext(snapshot(paths, dependencies), ['src/file0.ts']);
  assert.equal(result.directDependents.length, 1);
  assert.equal(result.transitiveDependents.length, 9_998);
  assert.equal(result.transitiveDependents.at(-1)?.distance, 9_999);
  const evidence = getDevelopmentEvidence(result, 'src/file9999.ts');
  assert.equal(evidence.length, 9_999);
  assert.equal(evidence[0]?.from, 'src/file9999.ts');
  assert.equal(evidence.at(-1)?.to, 'src/file0.ts');
});
