/**
 * Pure-function async chunk graph planner for plugin `client.tsx` compilation (no I/O, no esbuild dependency).
 *
 * Consumes Pass 1 metafile basename -> output metadata mapping (reading `imports` edges only) and computes
 * the module partitioning for code splitting plus prerequisite topological order. Extracted from
 * `client-compiler.ts` as pure functions so partitioning, reference counting, and topological sorting can
 * be unit-tested independently while preserving Set iteration order.
 */
import { basename } from 'node:path';

/** Dependency edge between metafile outputs (subset of esbuild `outputs[].imports`). */
export interface ChunkImportEdge {
  path: string;
  kind: string;
  external?: boolean;
}

/** Chunk graph node: only static and dynamic import edges are inspected. */
export interface ChunkGraphNode {
  imports?: ReadonlyArray<ChunkImportEdge>;
}

/** Chunk graph: output basename -> node metadata. */
export type ChunkGraph = ReadonlyMap<string, ChunkGraphNode>;

function staticImportTargets(graph: ChunkGraph, file: string): string[] {
  const imports = graph.get(file)?.imports;
  if (!imports) return [];
  const targets: string[] = [];
  for (const imp of imports) {
    if (imp.kind !== 'import-statement') continue;
    const b = basename(imp.path);
    if (graph.has(b)) targets.push(b);
  }
  return targets;
}

function expandStaticDfs(
  graph: ChunkGraph,
  seeds: Iterable<string>,
  options: { includeSeeds: boolean; allow?: (basename: string) => boolean },
): Set<string> {
  const visited = new Set<string>(options.includeSeeds ? seeds : []);
  const allow = options.allow;
  const visit = (file: string): void => {
    for (const target of staticImportTargets(graph, file)) {
      if (visited.has(target)) continue;
      if (allow !== undefined && !allow(target)) continue;
      visited.add(target);
      visit(target);
    }
  };
  for (const seed of seeds) visit(seed);
  return visited;
}

/**
 * Entry static import closure (includes the entry itself): depth-first traversal following static
 * `import-statement` edges, keeping only basenames present in the output graph.
 */
export function collectStaticImportClosure(graph: ChunkGraph, entry: string): Set<string> {
  return expandStaticDfs(graph, [entry], { includeSeeds: true });
}

/**
 * Reachable dynamic import targets: scans dynamic imports inside `baseClosure`, then breadth-first
 * traverses each target's static closure to discover transitive dynamic imports.
 */
export function collectDynamicImportTargets(
  graph: ChunkGraph,
  baseClosure: ReadonlySet<string>,
): Set<string> {
  const dynamicTargets = new Set<string>();
  const dynQueue: string[] = [];
  const collectDynamicEdges = (file: string): void => {
    const imports = graph.get(file)?.imports;
    if (!imports) return;
    for (const imp of imports) {
      if (imp.kind !== 'dynamic-import' || imp.external) continue;
      const b = basename(imp.path);
      if (graph.has(b) && !dynamicTargets.has(b)) {
        dynamicTargets.add(b);
        dynQueue.push(b);
      }
    }
  };
  for (const file of baseClosure) collectDynamicEdges(file);
  for (let dynHead = 0; dynHead < dynQueue.length; dynHead += 1) {
    const root = dynQueue[dynHead]!;
    const visited = new Set<string>([root]);
    const staticQueue = [root];
    for (let staticHead = 0; staticHead < staticQueue.length; staticHead += 1) {
      const cur = staticQueue[staticHead]!;
      collectDynamicEdges(cur);
      for (const target of staticImportTargets(graph, cur)) {
        if (!visited.has(target)) {
          visited.add(target);
          staticQueue.push(target);
        }
      }
    }
  }
  return dynamicTargets;
}

/** Partitioning plan: shared async chunks plus prerequisite topological order per dynamic unit. */
export interface AsyncChunkPlan {
  /** Modules referenced by >= 2 async units (including transitive dependencies), registered via namespace bridge. */
  sharedAsyncChunks: Set<string>;
  /** Async unit -> ordered list of prerequisite shared chunks (dependencies precede consumers). */
  chunkDeps: Record<string, string[]>;
}

function topoSortSharedChunks(graph: ChunkGraph, neededShared: ReadonlySet<string>): string[] {
  const sorted: string[] = [];
  const visited = new Set<string>();
  const visit = (chunk: string): void => {
    if (visited.has(chunk)) return;
    visited.add(chunk);
    for (const dep of staticImportTargets(graph, chunk)) {
      if (neededShared.has(dep)) visit(dep);
    }
    sorted.push(chunk);
  };
  for (const chunk of neededShared) visit(chunk);
  return sorted;
}

/**
 * Partition async units and topologically sort shared prerequisites:
 * 1. Compute each dynamic target's exclusive static closure (excluding `baseClosure` members);
 * 2. Reference-count across dynamic closures; promote modules referenced by >= 2 units to `sharedAsyncChunks`
 *    and transitively include their static dependencies;
 * 3. For each dynamic unit, topologically sort its required shared chunks via post-order DFS.
 */
export function computeAsyncChunkPlan(
  graph: ChunkGraph,
  baseClosure: ReadonlySet<string>,
  dynamicTargets: ReadonlySet<string>,
): AsyncChunkPlan {
  const dynStaticClosures = new Map<string, Set<string>>();
  for (const target of dynamicTargets) {
    dynStaticClosures.set(
      target,
      expandStaticDfs(graph, [target], {
        includeSeeds: false,
        allow: (b) => !baseClosure.has(b),
      }),
    );
  }

  const refCount = new Map<string, number>();
  for (const closure of dynStaticClosures.values()) {
    for (const chunk of closure) {
      refCount.set(chunk, (refCount.get(chunk) ?? 0) + 1);
    }
  }
  const initialShared = [...refCount.entries()]
    .filter(([, count]) => count >= 2)
    .map(([chunk]) => chunk);
  const sharedAsyncChunks = expandStaticDfs(graph, initialShared, {
    includeSeeds: true,
    allow: (b) => !baseClosure.has(b),
  });

  const chunkDeps: Record<string, string[]> = {};
  for (const target of dynamicTargets) {
    const staticClosure = dynStaticClosures.get(target) ?? new Set<string>();
    const initialNeeded = [...staticClosure].filter((c) => sharedAsyncChunks.has(c));
    const neededShared = expandStaticDfs(graph, initialNeeded, {
      includeSeeds: true,
      allow: (b) => sharedAsyncChunks.has(b),
    });
    chunkDeps[target] = topoSortSharedChunks(graph, neededShared);
  }

  return { sharedAsyncChunks, chunkDeps };
}
