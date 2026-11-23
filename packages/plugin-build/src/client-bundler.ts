/**
 * Two-pass esbuild bundler for plugin `client.tsx` modules:
 * - Pass 1 runs in-memory esbuild with `splitting: true` and containment/CSS/shared-shim plugins
 *   to analyze static/dynamic import graphs and extract merged CSS;
 * - Pass 2 either converges a single self-contained entry bundle (when no dynamic imports exist)
 *   or emits namespace-bridged async chunks (`__helmx_chunk_share` + `__helmx_import_chunk`) for
 *   Bearer-safe Blob URL lazy loading (e.g. Mermaid diagram engines).
 */
import { basename, join, relative } from 'node:path';
import { promisify } from 'node:util';
import { gzip, gzipSync } from 'node:zlib';
import { HelmxError, PLUGIN_CLIENT_CSS_EXPORT, type PluginClientNpmRoot } from '@helmx/protocol';
import { build, transform } from 'esbuild';
import {
  collectDynamicImportTargets,
  collectStaticImportClosure,
  computeAsyncChunkPlan,
  type ChunkGraphNode,
} from './client-chunk-graph.js';
import {
  buildDepsList,
  collectLocalDependencies,
  collectNpmDependencies,
  type DepsListFile,
} from './client-cache.js';
import {
  appendCssExport,
  containmentPlugin,
  cssPolicyPlugin,
  sharedShimPlugin,
} from './client-containment.js';

type Pass1OutputMeta = ChunkGraphNode & {
  entryPoint?: string;
  exports?: string[];
};

export interface BuiltClientArtifacts {
  mainJs: string;
  entryExports: string[];
  list: DepsListFile;
  chunks: Record<string, { code: string; gzipped?: Uint8Array }>;
}

function wrapCompileError(pluginId: string, moduleRef: string, phase: string, err: unknown): HelmxError {
  if (err instanceof HelmxError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new HelmxError('client_compile_failed', `plugin ${pluginId} ${phase} ${moduleRef} failed: ${message}`, 422, {
    pluginId,
    module: moduleRef,
  });
}

function locateEntryBaseName(
  pluginId: string,
  moduleRef: string,
  rootReal: string,
  entryReal: string,
  metaByBase: ReadonlyMap<string, Pass1OutputMeta>,
  virtualFiles: ReadonlyMap<string, string>,
): string {
  const relEntry = relative(rootReal, entryReal);
  for (const [base, meta] of metaByBase) {
    if (meta.entryPoint && (meta.entryPoint === relEntry || meta.entryPoint === entryReal || meta.entryPoint.endsWith(moduleRef))) {
      return base;
    }
  }
  if (virtualFiles.size === 1) {
    return virtualFiles.keys().next().value!;
  }
  throw new HelmxError(
    'client_compile_failed',
    `plugin ${pluginId} compile ${moduleRef} could not uniquely locate entry JS output`,
    500,
    { pluginId, module: moduleRef },
  );
}

/** Runs Pass 1 + Pass 2 esbuild compilation and returns the converged bundle artifacts + manifest. */
export async function compileClientBundle(params: {
  pluginId: string;
  rootReal: string;
  entryReal: string;
  moduleRef: string;
  stagingDir: string;
  npmRoots: ReadonlyArray<PluginClientNpmRoot>;
}): Promise<BuiltClientArtifacts> {
  const { pluginId, rootReal, entryReal, moduleRef, stagingDir, npmRoots } = params;

  let pass1Result: Awaited<ReturnType<typeof build>>;
  try {
    pass1Result = await build({
      entryPoints: [entryReal],
      bundle: true,
      splitting: true,
      format: 'esm',
      target: 'es2022',
      platform: 'browser',
      jsx: 'automatic',
      write: false,
      sourcemap: false,
      metafile: true,
      absWorkingDir: rootReal,
      outdir: join(stagingDir, '__virtual_out__'),
      logLevel: 'silent',
      plugins: [
        sharedShimPlugin(),
        containmentPlugin(pluginId, rootReal, entryReal, npmRoots),
        cssPolicyPlugin(pluginId),
      ],
    });
  } catch (err) {
    throw wrapCompileError(pluginId, moduleRef, 'compile', err);
  }

  const pass1Metafile = pass1Result.metafile;
  const pass1OutputFiles = pass1Result.outputFiles;
  if (!pass1Metafile || !pass1OutputFiles) {
    throw new HelmxError('client_compile_failed', `plugin ${pluginId} Pass 1 build produced no metafile or outputFiles`, 500);
  }

  // Guard the compiler-reserved CSS export name against accidental collision.
  if (Object.values(pass1Metafile.outputs).some((file) => file.exports?.includes(PLUGIN_CLIENT_CSS_EXPORT))) {
    throw new HelmxError(
      'client_compile_failed',
      `plugin ${pluginId} module ${moduleRef} uses reserved compiler export name "${PLUGIN_CLIENT_CSS_EXPORT}"; please rename that export`,
      422,
      { pluginId, module: moduleRef, reservedExport: PLUGIN_CLIENT_CSS_EXPORT },
    );
  }

  const virtualFiles = new Map<string, string>();
  const metaByBase = new Map<string, Pass1OutputMeta>();
  const cssFiles: string[] = [];

  for (const f of pass1OutputFiles) {
    const b = basename(f.path);
    if (b.endsWith('.css')) cssFiles.push(f.text);
    else if (b.endsWith('.js')) virtualFiles.set(b, f.text);
  }
  for (const [outPath, meta] of Object.entries(pass1Metafile.outputs)) {
    if (outPath.endsWith('.js')) metaByBase.set(basename(outPath), meta);
  }

  const css = cssFiles.join('\n');
  const entryBaseName = locateEntryBaseName(pluginId, moduleRef, rootReal, entryReal, metaByBase, virtualFiles);
  const dependencies = collectLocalDependencies(pass1Metafile, rootReal);
  const npmDeps = collectNpmDependencies(pass1Metafile, rootReal, npmRoots);
  const baseClosure = collectStaticImportClosure(metaByBase, entryBaseName);
  const dynamicTargets = collectDynamicImportTargets(metaByBase, baseClosure);
  const entryExports = [...(metaByBase.get(entryBaseName)?.exports ?? []), ...(css.length > 0 ? [PLUGIN_CLIENT_CSS_EXPORT] : [])];

  // Fast path: no dynamic imports -> converge into a single self-contained entry bundle.
  if (dynamicTargets.size === 0) {
    const mainJs = await convergeSingleBundle(pluginId, moduleRef, entryBaseName, virtualFiles, css);
    const list = buildDepsList(rootReal, moduleRef, dependencies, npmDeps, npmRoots, entryExports);
    return { mainJs, entryExports, list, chunks: {} };
  }

  // Split path: compute shared async chunks + prerequisite topological order and emit namespace bridges.
  const { sharedAsyncChunks, chunkDeps } = computeAsyncChunkPlan(metaByBase, baseClosure, dynamicTargets);
  const allUnits = new Set<string>([...sharedAsyncChunks, ...dynamicTargets]);
  const list = buildDepsList(rootReal, moduleRef, dependencies, npmDeps, npmRoots, entryExports, Array.from(allUnits));

  const { mainJs, chunks } = await convergeSplitBundles({
    pluginId,
    moduleRef,
    contentHash: list.contentHash,
    entryBaseName,
    css,
    virtualFiles,
    metaByBase,
    baseClosure,
    sharedAsyncChunks,
    chunkDeps,
    allUnits,
  });

  return { mainJs, entryExports, list, chunks };
}

const gzipAsync = promisify(gzip);
const ASYNC_GZIP_THRESHOLD_BYTES = 32 * 1024;

async function convergeSingleBundle(
  pluginId: string,
  moduleRef: string,
  entryBaseName: string,
  virtualFiles: ReadonlyMap<string, string>,
  css: string,
): Promise<string> {
  try {
    if (virtualFiles.size === 1) {
      const transformed = await transform(virtualFiles.get(entryBaseName)!, {
        loader: 'js',
        format: 'esm',
        target: 'es2022',
        sourcemap: false,
        minifyWhitespace: true,
        minifyIdentifiers: true,
        minifySyntax: true,
        logLevel: 'silent',
        sourcefile: entryBaseName,
      });
      return appendCssExport(transformed.code, css);
    }
    const pass2 = await build({
      stdin: {
        contents: virtualFiles.get(entryBaseName)!,
        loader: 'js',
        sourcefile: entryBaseName,
      },
      bundle: true,
      format: 'esm',
      target: 'es2022',
      platform: 'browser',
      write: false,
      sourcemap: false,
      minifyWhitespace: true,
      minifyIdentifiers: true,
      minifySyntax: true,
      logLevel: 'silent',
      plugins: [
        {
          name: 'vfs-resolver',
          setup(b) {
            b.onResolve({ filter: /.*/ }, (args) => ({ path: basename(args.path), namespace: 'vfs' }));
            b.onLoad({ filter: /.*/, namespace: 'vfs' }, (args) => {
              const content = virtualFiles.get(args.path);
              if (content === undefined) return { errors: [{ text: `Missing virtual file: ${args.path}` }] };
              return { contents: content, loader: 'js' };
            });
          },
        },
      ],
    });
    return appendCssExport(pass2.outputFiles[0]!.text, css);
  } catch (err) {
    throw wrapCompileError(pluginId, moduleRef, 'convergence', err);
  }
}

async function convergeSplitBundles(params: {
  pluginId: string;
  moduleRef: string;
  contentHash: string;
  entryBaseName: string;
  css: string;
  virtualFiles: Map<string, string>;
  metaByBase: ReadonlyMap<string, Pass1OutputMeta>;
  baseClosure: ReadonlySet<string>;
  sharedAsyncChunks: ReadonlySet<string>;
  chunkDeps: Readonly<Record<string, string[]>>;
  allUnits: ReadonlySet<string>;
}): Promise<{ mainJs: string; chunks: Record<string, { code: string; gzipped?: Uint8Array }> }> {
  const {
    pluginId,
    moduleRef,
    contentHash,
    entryBaseName,
    css,
    virtualFiles,
    metaByBase,
    baseClosure,
    sharedAsyncChunks,
    chunkDeps,
    allUnits,
  } = params;

  const chunkShareKeyExpr = (file: string): string =>
    JSON.stringify(`${pluginId}\0${moduleRef}\0${contentHash}\0${file}`);

  // Register shared virtual chunks via `import * as ns` into `globalThis.__helmx_chunk_share`
  // so esbuild retains every export kind cleanly and plugins remain isolated by hash key.
  const filesToRegister = new Set<string>([...baseClosure, ...sharedAsyncChunks]);
  filesToRegister.delete(entryBaseName);
  const chunkNsBridges = new Map<string, string>();
  for (const file of filesToRegister) {
    if (!virtualFiles.has(file)) continue;
    const bridgeName = `__helmx_ns__:${file}`;
    chunkNsBridges.set(file, bridgeName);
    virtualFiles.set(
      bridgeName,
      `import * as __helmx_ns from ${JSON.stringify(`__helmx_chunk__:${file}`)};\n` +
        `;(globalThis.__helmx_chunk_share ??= {})[${chunkShareKeyExpr(file)}] = __helmx_ns;\n`,
    );
  }

  const baseRegisterFiles = [...baseClosure].filter((f) => f !== entryBaseName && virtualFiles.has(f));

  async function bundleUnit(unitName: string, isMain: boolean): Promise<string> {
    const isNsBridge = !isMain && sharedAsyncChunks.has(unitName);
    let unitCode = virtualFiles.get(isNsBridge ? chunkNsBridges.get(unitName)! : unitName);
    if (unitCode === undefined) {
      throw new HelmxError('client_compile_failed', `Missing virtual file ${unitName}`, 500);
    }
    if (isMain && baseRegisterFiles.length > 0) {
      const regImports = baseRegisterFiles.map((f) => `import ${JSON.stringify(`__helmx_ns__:${f}`)};`).join('\n');
      unitCode = `${regImports}\n${unitCode}`;
    }
    const res = await build({
      stdin: {
        contents: unitCode,
        loader: 'js',
        sourcefile: unitName,
      },
      bundle: true,
      format: 'esm',
      target: 'es2022',
      platform: 'browser',
      write: false,
      sourcemap: false,
      minifyWhitespace: true,
      minifyIdentifiers: true,
      minifySyntax: true,
      logLevel: 'silent',
      plugins: [
        {
          name: 'pass2-resolver',
          setup(b) {
            b.onResolve({ filter: /.*/ }, (args) => {
              if (args.kind === 'dynamic-import') {
                return { path: `__HELMX_DYN_IMPORT__:${basename(args.path)}`, external: true };
              }
              if (args.kind === 'import-statement') {
                if (args.path.startsWith('__helmx_chunk__:')) {
                  return { path: basename(args.path.slice('__helmx_chunk__:'.length)), namespace: 'vfs' };
                }
                if (args.path.startsWith('__helmx_ns__:')) {
                  return { path: args.path, namespace: 'vfs' };
                }
                const target = basename(args.path);
                if (!isMain && (baseClosure.has(target) || sharedAsyncChunks.has(target)) && target !== unitName) {
                  return { path: target, namespace: 'proxy' };
                }
                return { path: target, namespace: 'vfs' };
              }
              return null;
            });
            b.onLoad({ filter: /.*/, namespace: 'proxy' }, (args) => {
              const target = args.path;
              const exports = metaByBase.get(target)?.exports ?? [];
              const proxyLines = [`const __s = (globalThis.__helmx_chunk_share ?? {})[${chunkShareKeyExpr(target)}] || {};`];
              for (const exp of exports) {
                proxyLines.push(exp === 'default' ? 'export default __s["default"];' : `export const ${exp} = __s[${JSON.stringify(exp)}];`);
              }
              if (exports.length === 0) proxyLines.push('export {};');
              return { contents: proxyLines.join('\n'), loader: 'js' };
            });
            b.onLoad({ filter: /.*/, namespace: 'vfs' }, (args) => {
              const content = virtualFiles.get(args.path);
              if (content === undefined) return { errors: [{ text: `Missing virtual file: ${args.path}` }] };
              return { contents: content, loader: 'js' };
            });
          },
        },
      ],
    });
    return res.outputFiles[0]!.text.replace(
      /import\s*\(\s*["'`]__HELMX_DYN_IMPORT__:([^"'`]+)["'`]\s*\)/g,
      (_match, target: string) => {
        const deps = chunkDeps[target] ?? [];
        return `globalThis.__helmx_import_chunk(${JSON.stringify(pluginId)}, ${JSON.stringify(moduleRef)}, ${JSON.stringify(contentHash)}, ${JSON.stringify(target)}, ${JSON.stringify(deps)})`;
      },
    );
  }

  let mainJs: string;
  try {
    mainJs = appendCssExport(await bundleUnit(entryBaseName, true), css);
  } catch (err) {
    throw wrapCompileError(pluginId, moduleRef, 'main bundle convergence', err);
  }

  const chunks: Record<string, { code: string; gzipped?: Uint8Array }> = {};
  try {
    await Promise.all(
      Array.from(allUnits).map(async (unitName) => {
        const code = await bundleUnit(unitName, false);
        const codeBuf = Buffer.from(code, 'utf8');
        let gzipped: Uint8Array | undefined;
        try {
          gzipped = codeBuf.byteLength >= ASYNC_GZIP_THRESHOLD_BYTES ? await gzipAsync(codeBuf) : gzipSync(codeBuf);
        } catch {
          /* ignore */
        }
        chunks[unitName] = { code, gzipped };
      }),
    );
  } catch (err) {
    throw wrapCompileError(pluginId, moduleRef, 'chunk convergence', err);
  }

  return { mainJs, chunks };
}
