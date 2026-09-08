import type {
  FileDependency,
  FileRole,
  ProjectSnapshot,
  SourceRef,
  StructureNode,
} from './model';

export interface DevelopmentFile {
  path: string;
  nodeId: string;
  source: SourceRef;
  role: FileRole;
}

export interface DevelopmentImpactFile extends DevelopmentFile {
  /** Shortest number of resolved imports between this file and a seed. */
  distance: number;
  seedPath: string;
  /** First step from this dependent toward its seed; `from` imports `to`. */
  via: FileDependency;
}

export interface DevelopmentDependencyFile extends DevelopmentFile {
  distance: 1;
  seedPath: string;
  /** A seed imports this dependency. */
  via: FileDependency;
}

export type DevelopmentTestFile =
  | (DevelopmentImpactFile & { reason: 'dependency' })
  | (DevelopmentFile & { reason: 'filename'; seedPath: string });

export interface DevelopmentContext {
  seeds: DevelopmentFile[];
  directDependents: DevelopmentImpactFile[];
  /** Dependents at distance two or more; disjoint from directDependents. */
  transitiveDependents: DevelopmentImpactFile[];
  directDependencies: DevelopmentDependencyFile[];
  suggestedTests: DevelopmentTestFile[];
  /** Requested files absent from this scan, including deleted/excluded files. */
  unindexedPaths: string[];
}

const evidenceIndexes = new WeakMap<DevelopmentContext, ReadonlyMap<string, DevelopmentImpactFile>>();

/**
 * Compute candidate change impact using the file imports actually retained by
 * the scanner. The reverse traversal is a multi-source BFS: cycles and diamonds
 * visit each file once, and a 10,000-file chain stores 10,000 parent edges rather
 * than 50 million duplicated path entries. Evidence is expanded only on request.
 * Nothing here claims runtime reachability or complete test coverage.
 */
export function buildDevelopmentContext(
  snapshot: ProjectSnapshot,
  paths: readonly string[],
): DevelopmentContext {
  const files = indexFiles(snapshot.structure);
  const requested = [...new Set(paths.map(normalizePath).filter(Boolean))].sort(comparePaths);
  const seeds: DevelopmentFile[] = [];
  const unindexedPaths: string[] = [];
  for (const path of requested) {
    const indexed = files.get(path);
    if (indexed) seeds.push(indexed);
    else unindexedPaths.push(path);
  }
  const seedPaths = new Set(seeds.map((file) => file.path));
  const incoming = new Map<string, FileDependency[]>();
  const outgoing = new Map<string, FileDependency[]>();
  const edges = new Map<string, FileDependency>();
  for (const dependency of snapshot.fileDependencies ?? []) {
    const edge = { ...dependency, from: normalizePath(dependency.from), to: normalizePath(dependency.to) };
    if (edge.from === edge.to || edge.confidence === 'unresolved'
      || !files.has(edge.from) || !files.has(edge.to)) continue;
    const key = `${edge.from}\u0000${edge.to}`;
    const previous = edges.get(key);
    if (!previous || evidenceRank(edge, previous) < 0) edges.set(key, edge);
  }
  // Stable neighbour order makes equal-length evidence independent of input order.
  for (const edge of [...edges.values()].sort((left, right) =>
    comparePaths(left.from, right.from) || comparePaths(left.to, right.to))) {
    addEdge(incoming, edge.to, edge);
    addEdge(outgoing, edge.from, edge);
  }

  const impacts = new Map<string, DevelopmentImpactFile>();
  const queue = seeds.map((file) => ({ path: file.path, distance: 0, seedPath: file.path }));
  const visited = new Set(seedPaths);
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor];
    if (!current) continue;
    for (const via of incoming.get(current.path) ?? []) {
      if (visited.has(via.from)) continue;
      const file = files.get(via.from);
      if (!file) continue;
      visited.add(via.from);
      const impact: DevelopmentImpactFile = {
        ...file,
        source: { file: file.path, line: via.line },
        distance: current.distance + 1,
        seedPath: current.seedPath,
        via,
      };
      impacts.set(file.path, impact);
      queue.push(impact);
    }
  }
  const sortedImpacts = [...impacts.values()].sort((left, right) =>
    left.distance - right.distance || comparePaths(left.path, right.path));
  const dependencies = new Map<string, DevelopmentDependencyFile>();
  for (const seed of seeds) {
    for (const via of outgoing.get(seed.path) ?? []) {
      if (seedPaths.has(via.to) || dependencies.has(via.to)) continue;
      const file = files.get(via.to);
      if (file) dependencies.set(file.path, { ...file, distance: 1, seedPath: seed.path, via });
    }
  }

  const tests = new Map<string, DevelopmentTestFile>();
  for (const impact of sortedImpacts) {
    if (isTestCandidate(impact)) tests.set(impact.path, { ...impact, reason: 'dependency' });
  }
  const roots = new Set(snapshot.projectRoots.map(normalizePath));
  const rootCache = new Map<string, string>();
  const seedNames = new Map<string, string>();
  for (const seed of seeds) {
    if (seed.role !== 'source' && seed.role !== 'entry') continue;
    const key = `${projectRoot(seed.path, roots, rootCache)}\u0000${testSubjectName(seed.path)}`;
    if (!seedNames.has(key)) seedNames.set(key, seed.path);
  }
  for (const file of files.values()) {
    if (!isTestCandidate(file) || tests.has(file.path) || seedPaths.has(file.path)) continue;
    const key = `${projectRoot(file.path, roots, rootCache)}\u0000${testSubjectName(file.path)}`;
    const seedPath = seedNames.get(key);
    if (seedPath) tests.set(file.path, { ...file, reason: 'filename', seedPath });
  }

  const context: DevelopmentContext = {
    seeds,
    directDependents: sortedImpacts.filter((file) => file.distance === 1),
    transitiveDependents: sortedImpacts.filter((file) => file.distance > 1),
    directDependencies: [...dependencies.values()].sort((left, right) => comparePaths(left.path, right.path)),
    suggestedTests: [...tests.values()].sort((left, right) => {
      if (left.reason !== right.reason) return left.reason === 'dependency' ? -1 : 1;
      const distance = left.reason === 'dependency' && right.reason === 'dependency'
        ? left.distance - right.distance : 0;
      return distance || comparePaths(left.path, right.path);
    }),
    unindexedPaths,
  };
  evidenceIndexes.set(context, impacts);
  return context;
}

/**
 * Return the shortest import chain from a dependent toward the changed seed.
 * For a direct dependency, return the seed's import edge. An empty array means
 * no dependency evidence exists (for example a filename-only test suggestion).
 */
export function getDevelopmentEvidence(context: DevelopmentContext, path: string): FileDependency[] {
  let index = evidenceIndexes.get(context);
  if (!index) {
    index = new Map([...context.directDependents, ...context.transitiveDependents].map((file) => [file.path, file]));
    evidenceIndexes.set(context, index);
  }
  const normalized = normalizePath(path);
  const result: FileDependency[] = [];
  const visited = new Set<string>();
  let current = index.get(normalized);
  while (current && !visited.has(current.path)) {
    visited.add(current.path);
    result.push(current.via);
    current = index.get(current.via.to);
  }
  if (!result.length) {
    const dependency = context.directDependencies.find((file) => file.path === normalized);
    if (dependency) result.push(dependency.via);
  }
  return result;
}

function indexFiles(root: StructureNode): Map<string, DevelopmentFile> {
  const result = new Map<string, DevelopmentFile>();
  const queue = [root];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const node = queue[cursor];
    if (!node) continue;
    if (node.kind === 'file') {
      const path = normalizePath(node.path);
      result.set(path, {
        path,
        nodeId: node.id,
        source: node.source ?? { file: path, line: 1 },
        role: node.role ?? 'other',
      });
    } else {
      for (const child of node.children) queue.push(child);
    }
  }
  return result;
}

function addEdge(index: Map<string, FileDependency[]>, path: string, edge: FileDependency): void {
  const group = index.get(path);
  if (group) group.push(edge);
  else index.set(path, [edge]);
}

function evidenceRank(left: FileDependency, right: FileDependency): number {
  const confidence = Number(right.confidence === 'exact') - Number(left.confidence === 'exact');
  return confidence || left.line - right.line;
}

const TEST_CODE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'java', 'kt', 'kts', 'go', 'rs',
  'cs', 'php', 'rb', 'dart', 'swift', 'c', 'cc', 'cpp', 'cxx',
]);

function isTestCandidate(file: DevelopmentFile): boolean {
  return file.role === 'test'
    && TEST_CODE_EXTENSIONS.has(file.path.split('.').at(-1)?.toLowerCase() ?? '')
    && !file.path.split('/').some((part) => ['fixtures', 'fixture', '__mocks__'].includes(part.toLowerCase()));
}

function testSubjectName(path: string): string {
  const name = path.split('/').at(-1) ?? '';
  const stem = name.replace(/\.[^.]+$/, '');
  return stem.replace(/(?:\.(?:test|spec)|_test)$/i, '')
    .replace(/^test_/i, '').replace(/(?:Tests?|Specs?)$/, '').toLowerCase();
}

function projectRoot(path: string, roots: ReadonlySet<string>, cache: Map<string, string>): string {
  let directory = path.slice(0, Math.max(0, path.lastIndexOf('/')));
  const traversed: string[] = [];
  while (directory) {
    const cached = cache.get(directory);
    if (cached !== undefined || roots.has(directory)) {
      const root = cached ?? directory;
      for (const visited of traversed) cache.set(visited, root);
      return root;
    }
    traversed.push(directory);
    directory = directory.slice(0, Math.max(0, directory.lastIndexOf('/')));
  }
  for (const visited of traversed) cache.set(visited, '');
  return '';
}

function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.replaceAll('\\', '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

function comparePaths(left: string, right: string): number {
  return left.localeCompare(right);
}
