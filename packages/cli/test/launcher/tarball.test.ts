/**
 * Tarball security tests for the Hub launcher staging:
 *
 * `unpackPayloadTarball` policy: only regular files/directories under `package/` are allowed;
 * links, path escapes, absolute members, foreign roots, backslashes, empty archives, missing
 * `package/package.json`, and corrupt archives are rejected explicitly (crafted raw ustar
 * archives — node-tar's list mode happily emits escaping paths, so the launcher's own policy is
 * the gate). Nested-dependency golden staging tests live in `update-flow.test.ts`.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { useTempDir } from '@helmx/test-kit/node';
import { unpackPayloadTarball } from '@helmx/env-io/hub-payload';
import {
  fixtureTarballPacker,
  writeFakePayload,
} from './fixtures.js';

const PKG = '@fake/hub-payload';

/** Craft a raw ustar header (hand-rolled so hostile members npm would never produce can be tested). */
function ustarHeader(name: string, typeFlag: string, options?: { linkname?: string; size?: number }): Buffer {
  const size = options?.size ?? 0;
  const block = Buffer.alloc(512, 0);
  block.write(name.slice(0, 100), 0, 'utf8');
  block.write('0000644\0', 100, 8, 'utf8');
  block.write('0000000\0', 108, 8, 'utf8');
  block.write('0000000\0', 116, 8, 'utf8');
  block.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'utf8');
  block.write('00000000000\0', 136, 12, 'utf8');
  block.write('        ', 148, 8, 'utf8'); // checksum placeholder while summing
  block.write(typeFlag, 156, 1, 'utf8');
  if (options?.linkname !== undefined) block.write(options.linkname.slice(0, 100), 157, 100, 'utf8');
  block.write('ustar\0', 257, 6, 'utf8');
  block.write('00', 263, 2, 'utf8');
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'utf8');
  return block;
}

/** An uncompressed tar archive from raw members (files carry one padded content block). */
function rawTar(members: Buffer[]): Buffer {
  return Buffer.concat([...members, Buffer.alloc(1024, 0)]);
}

function fileMember(name: string, content = 'x'): Buffer[] {
  const body = Buffer.concat([Buffer.from(content, 'utf8'), Buffer.alloc(512, 0)]).subarray(0, 512);
  return [ustarHeader(name, '0', { size: 512 }), body];
}

test('a well-formed package/ archive unpacks to the destination root with the prefix stripped', { timeout: 60_000 }, async (t) => {
  const root = useTempDir(t, 'helmx-launcher-untar-');
  const payloadDir = path.join(root, 'payload');
  await writeFakePayload({ dir: payloadDir, pkgName: PKG, version: '1.0.0' });
  const tgz = await fixtureTarballPacker()(payloadDir);

  const dest = path.join(root, 'dest');
  await fsp.mkdir(dest, { recursive: true });
  await unpackPayloadTarball(tgz, dest);
  assert.ok(existsSync(path.join(dest, 'package.json')));
  assert.ok(existsSync(path.join(dest, 'start.mjs')));
  assert.ok(existsSync(path.join(dest, 'manifest.json')));
  assert.equal(JSON.parse(readFileSync(path.join(dest, 'package.json'), 'utf8')).name, PKG);
});

test('unpack rejects links, escapes, foreign roots, and backslashes with explicit errors', { timeout: 60_000 }, async (t) => {
  const root = useTempDir(t, 'helmx-launcher-untarevil-');
  const dest = path.join(root, 'dest');
  const write = async (name: string, members: Buffer[]): Promise<string> => {
    const file = path.join(root, name);
    await fsp.writeFile(file, rawTar(members));
    return file;
  };

  const good = fileMember('package/package.json', '{}');
  const cases: Array<{ name: string; members: Buffer[]; message: RegExp }> = [
    {
      name: 'symlink.tar',
      members: [...good, ustarHeader('package/evil-link', '2', { linkname: '/etc/passwd' })],
      message: /type SymbolicLink; only regular files and directories are allowed/,
    },
    {
      name: 'hardlink.tar',
      members: [...good, ustarHeader('package/evil-hard', '1', { linkname: 'package.json' })],
      message: /type Link; only regular files and directories are allowed/,
    },
    {
      name: 'escape.tar',
      members: [...good, ...fileMember('../escape.txt')],
      message: /entry "..\/escape\.txt" is outside the package\/ root/,
    },
    {
      name: 'absolute.tar',
      members: [...good, ...fileMember('/abs/file.txt')],
      message: /entry "\/abs\/file\.txt" is outside the package\/ root/,
    },
    {
      name: 'foreign-root.tar',
      members: [...good, ...fileMember('notpackage/file.txt')],
      message: /entry "notpackage\/file\.txt" is outside the package\/ root/,
    },
    {
      name: 'backslash.tar',
      members: [...good, ...fileMember('package/back\\slash.txt')],
      message: /entry "package\/back\\slash\.txt" contains a backslash/,
    },
    {
      name: 'dotdot-inside.tar',
      members: [...good, ...fileMember('package/sub/../../evil.txt')],
      message: /contains a forbidden path segment/,
    },
  ];
  for (const testCase of cases) {
    await fsp.rm(dest, { recursive: true, force: true });
    await fsp.mkdir(dest, { recursive: true });
    await assert.rejects(
      unpackPayloadTarball(await write(testCase.name, testCase.members), dest),
      testCase.message,
      `${testCase.name} must be rejected`,
    );
  }
});

test('unpack rejects empty archives, directory-only archives, and missing package.json', { timeout: 60_000 }, async (t) => {
  const root = useTempDir(t, 'helmx-launcher-untarempty-');
  const dest = path.join(root, 'dest');
  await fsp.mkdir(dest, { recursive: true });

  // An end-of-archive-marker-only file: node-tar flags it TAR_BAD_ARCHIVE, which the launcher's
  // warnings-are-fatal gate refuses (an archive that cannot be fully parsed is never unpacked).
  const empty = path.join(root, 'empty.tar');
  await fsp.writeFile(empty, rawTar([]));
  await assert.rejects(unpackPayloadTarball(empty, dest), /refused|contains no entries/);

  const dirsOnly = path.join(root, 'dirs-only.tar');
  await fsp.writeFile(dirsOnly, rawTar([ustarHeader('package/', '5'), ustarHeader('package/sub/', '5')]));
  await assert.rejects(unpackPayloadTarball(dirsOnly, dest), /contains no regular files/);

  const noManifest = path.join(root, 'no-package-json.tar');
  await fsp.writeFile(noManifest, rawTar([...fileMember('package/start.mjs')]));
  await assert.rejects(unpackPayloadTarball(noManifest, dest), /has no package\/package\.json member/);
});

test('unpack refuses corrupt archives instead of partial extraction', { timeout: 60_000 }, async (t) => {
  const root = useTempDir(t, 'helmx-launcher-untarcorrupt-');
  const dest = path.join(root, 'dest');
  await fsp.mkdir(dest, { recursive: true });

  const garbage = path.join(root, 'garbage.tgz');
  await fsp.writeFile(garbage, Buffer.from('this is not a tarball at all, not even gzip\n'));
  await assert.rejects(unpackPayloadTarball(garbage, dest), /refused|unreadable/);

  // A valid gzip wrapper around corrupt tar content: parsing fails, nothing is unpacked.
  const payloadDir = path.join(root, 'payload');
  await writeFakePayload({ dir: payloadDir, pkgName: PKG, version: '1.0.0' });
  const tgz = await fixtureTarballPacker()(payloadDir);
  const bytes = Buffer.from(await fsp.readFile(tgz));
  const flipIndex = bytes.length - 200;
  bytes[flipIndex] = (bytes[flipIndex] ?? 0) ^ 0xff;
  const flipped = path.join(root, 'flipped.tgz');
  await fsp.writeFile(flipped, bytes);
  const before = await fsp.readdir(dest);
  await assert.rejects(unpackPayloadTarball(flipped, dest), /refused|unreadable|failed to extract/);
  assert.deepEqual(await fsp.readdir(dest), before, 'no partial extraction may land on disk');
});
