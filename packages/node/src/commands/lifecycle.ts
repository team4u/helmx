/**
 * Lifecycle commands: `connect` (bind + foreground), `start` (detached or controlled/launcher),
 * `stop`, `restart`, and `status`.
 */
import { UsageError } from '../cli-context.js';
import { readPidRecord } from '../cli-context.js';
import { controlRequest } from '../control.js';
import { startDaemon } from '../launcher.js';
import { runDaemonProcess } from '../daemon-process.js';
import { detectNodeInstallMode } from '../service-entry.js';
import {
  flagString,
  readNodeIdentityStrict,
  resolveHubUrl,
  statusDaemon,
  stopDaemon,
  type CommandContext,
} from './shared.js';

export async function connectCommand(ctx: CommandContext): Promise<number> {
  const { io, parsed, dataDir, emit } = ctx;
  const { bindIdentityFromJoinToken, readNodeIdentity, runNodeDaemonHandle } = await import('../daemon/index.js');
  const hubUrl =
    parsed.positional[0] !== undefined && /^https?:\/\//.test(parsed.positional[0]!)
      ? parsed.positional[0]!
      : await resolveHubUrl(io, parsed, true);
  const token = flagString(parsed, 'token');
  if (token === undefined) throw new UsageError('connect requires --token <token> (JOIN token nodeId:secret)', 'missing_token');
  await bindIdentityFromJoinToken(dataDir, token, hubUrl);
  const identity = await readNodeIdentity(dataDir);
  if (identity === null) throw new Error('failed to read identity after writing it (internal error)');
  if (parsed.flags.get('once') === true) {
    const handle = await runNodeDaemonHandle(
      { hubUrl, token },
      { dataDir, ...(io.installMode !== undefined ? { installMode: io.installMode } : {}) },
    );
    const ok = await handle.waitUntilRegistered(15_000);
    const reason = ok ? undefined : handle.lastRejectReason();
    await handle.close();
    if (parsed.json) {
      emit({ ok, nodeId: identity.nodeId, hubUrl, dataDir, registered: ok, ...(reason !== undefined ? { reason } : {}) });
    } else if (ok) {
      io.out(`connected and registered: node ${identity.nodeId} -> ${hubUrl}\n`);
    } else {
      io.err(
        `registration failed for node ${identity.nodeId} (${hubUrl})${reason !== undefined ? `: ${reason}` : ': timed out or Hub unreachable'}\n`,
      );
    }
    return ok ? 0 : 1;
  }
  return await runDaemonProcess({ io, json: parsed.json, dataDir, hubUrl, token, nodeId: identity.nodeId });
}

/** `start -d`: bind identity (optional) -> replace verified running daemon on `--token` -> spawn detached daemon -> record `node.pid`. */
async function startDetached(ctx: CommandContext, token: string | undefined, hubUrl: string): Promise<number> {
  const { io, parsed, dataDir, emit } = ctx;
  const { bindIdentityFromJoinToken } = await import('../daemon/index.js');
  let previousPid: number | null = null;
  if (token !== undefined) {
    // Bind first so invalid tokens, invalid Hub URLs, or cross-nodeId mismatches fail before stopping a running daemon.
    await bindIdentityFromJoinToken(dataDir, token, hubUrl);
    const existing = await readPidRecord(dataDir);
    if (existing !== null) {
      const status = await controlRequest(existing.endpoint, { type: 'status', instanceId: existing.instanceId });
      if (status !== null && status.ok === true) {
        await stopDaemon(io, dataDir);
        previousPid = existing.pid;
      }
    }
  }
  const identity = await readNodeIdentityStrict(dataDir);
  const effectiveHub = hubUrl !== '' ? hubUrl : identity.hubUrl ?? '';
  if (effectiveHub === '') throw new UsageError('detached start requires a Hub URL (--hub or bound hubUrl)', 'missing_hub_url');
  const { pid, logPath, readyState } = await startDaemon(io, dataDir, effectiveHub);
  const message =
    readyState === 'registered'
      ? `daemon started and registered with Hub (pid ${pid})`
      : `daemon started (pid ${pid}), registration not yet complete: will keep reconnecting with backoff if Hub is unreachable; check logs at ${logPath}`;
  if (parsed.json) {
    emit({
      ok: true,
      pid,
      dataDir,
      hubUrl: effectiveHub,
      nodeId: identity.nodeId,
      logPath,
      state: readyState,
      message,
      ...(previousPid !== null ? { previousPid } : {}),
    });
  } else {
    io.out(
      [
        ...(previousPid !== null ? [`stopped previous daemon (pid ${previousPid})`] : []),
        message,
        `node:     ${identity.nodeId}`,
        `hub:      ${effectiveHub}`,
        `state:    ${readyState}`,
        `log:      ${logPath}`,
      ].join('\n') + '\n',
    );
  }
  return 0;
}

/** Controlled `start` invoked by `start -d` or upgrade handoff with control env vars injected. */
async function startControlled(ctx: CommandContext, control: { instanceId: string; endpoint: string }, token: string | undefined, hubUrl: string): Promise<number> {
  const { io, parsed, dataDir } = ctx;
  const { readNodeIdentity } = await import('../daemon/index.js');
  const identity = await readNodeIdentity(dataDir);
  const effectiveToken = token ?? identity?.token;
  const effectiveHub = hubUrl !== '' ? hubUrl : identity?.hubUrl ?? '';
  if (effectiveToken === undefined || effectiveHub === '') {
    throw new UsageError(
      'controlled start requires a bound identity or --token + --hub; or use start -d to run in background',
      'missing_identity',
    );
  }
  return await runDaemonProcess({
    io,
    json: parsed.json,
    dataDir,
    hubUrl: effectiveHub,
    token: effectiveToken,
    nodeId: identity?.nodeId ?? '?',
    control,
  });
}

export async function startCommand(ctx: CommandContext): Promise<number> {
  const { io, parsed, dataDir } = ctx;
  const detached = parsed.flags.get('daemon') === true || parsed.flags.get('d') === true;
  const hubUrl = await resolveHubUrl(io, parsed, false);
  const token = flagString(parsed, 'token');
  if (detached) {
    return await startDetached(ctx, token, hubUrl);
  }
  // Controlled child (spawned with HELMX_NODE_INSTANCE_ID / HELMX_NODE_CONTROL_ENDPOINT) runs the daemon directly;
  // plain foreground `start` (systemd/launchd main process) enters the foreground launcher loop.
  const instanceId = io.env?.['HELMX_NODE_INSTANCE_ID'];
  const endpoint = io.env?.['HELMX_NODE_CONTROL_ENDPOINT'];
  if (instanceId !== undefined && instanceId !== '' && endpoint !== undefined && endpoint !== '') {
    return await startControlled(ctx, { instanceId, endpoint }, token, hubUrl);
  }
  const { bindIdentityFromJoinToken } = await import('../daemon/index.js');
  const { runForegroundLauncher } = await import('../launcher.js');
  if (token !== undefined && hubUrl !== '') {
    await bindIdentityFromJoinToken(dataDir, token, hubUrl);
  }
  const launcherIdentity = await readNodeIdentityStrict(dataDir);
  const launcherHub = hubUrl !== '' ? hubUrl : launcherIdentity.hubUrl ?? '';
  if (launcherHub === '') throw new UsageError('launcher start requires a Hub URL (--hub or bound hubUrl)', 'missing_hub_url');
  return await runForegroundLauncher(io, dataDir, launcherHub, parsed.json);
}

export async function stopCommand(ctx: CommandContext): Promise<number> {
  const { io, parsed, dataDir, emit } = ctx;
  const stopped = await stopDaemon(io, dataDir);
  if (parsed.json) {
    emit({ ok: true, stopped: true, outcome: stopped.outcome, pid: stopped.pid, dataDir });
  } else {
    io.out(
      stopped.outcome === 'stale'
        ? `daemon was not running (removed stale pid ${stopped.pid})\n`
        : `daemon pid ${stopped.pid} stopped\n`,
    );
  }
  return 0;
}

export async function restartCommand(ctx: CommandContext): Promise<number> {
  const { io, parsed, dataDir, emit } = ctx;
  const { bindIdentityFromJoinToken, readNodeIdentity } = await import('../daemon/index.js');
  const hubUrl = await resolveHubUrl(io, parsed, false);
  const token = flagString(parsed, 'token');
  if (token !== undefined) {
    // Validate and bind new token/Hub before stopping the existing daemon.
    const existingIdentity = await readNodeIdentity(dataDir);
    const bindHub = hubUrl !== '' ? hubUrl : existingIdentity?.hubUrl ?? '';
    await bindIdentityFromJoinToken(dataDir, token, bindHub);
  }
  const identity = await readNodeIdentityStrict(dataDir);
  const effectiveHub = hubUrl !== '' ? hubUrl : identity.hubUrl ?? '';
  if (effectiveHub === '') throw new UsageError('restart requires a bound Hub URL (run helmx-node start -d --hub <url> --token <token> first)', 'missing_identity');
  const previous = await readPidRecord(dataDir);
  let previousPid: number | null = null;
  if (previous !== null) {
    previousPid = previous.pid;
    // stopDaemon throws on failure so we never spawn a second process alongside a live one.
    await stopDaemon(io, dataDir);
  }
  const { pid, logPath, readyState } = await startDaemon(io, dataDir, effectiveHub);
  if (parsed.json) {
    emit({
      ok: true,
      pid,
      dataDir,
      hubUrl: effectiveHub,
      nodeId: identity.nodeId,
      logPath,
      state: readyState,
      ...(previousPid !== null ? { previousPid } : {}),
    });
  } else {
    const lines = [
      ...(previousPid !== null ? [`stopped previous daemon (pid ${previousPid})`] : ['no previous daemon was running']),
      `started daemon (pid ${pid}, node ${identity.nodeId}, state ${readyState})`,
      `hub:      ${effectiveHub}`,
      `log:      ${logPath}`,
    ];
    io.out(`${lines.join('\n')}\n`);
  }
  return 0;
}

export async function statusCommand(ctx: CommandContext): Promise<number> {
  const { io, parsed, dataDir, emit } = ctx;
  const { readNodeIdentity } = await import('../daemon/index.js');
  const identity = await readNodeIdentity(dataDir);
  const daemon = await statusDaemon(io, dataDir);
  const installMode = daemon.installMode ?? io.installMode ?? detectNodeInstallMode();
  // Version priority: live daemon control-channel report -> mode-aware offline version
  // (source mode always reads own package.json and ignores stale current.json; release prefers current.json).
  const { resolveEffectiveNodeVersion } = await import('../daemon/upgrader.js');
  const version = daemon.version ?? (await resolveEffectiveNodeVersion(dataDir, installMode));
  const payload = {
    bound: identity !== null,
    ...(identity !== null ? { nodeId: identity.nodeId, hubUrl: identity.hubUrl ?? null } : {}),
    dataDir,
    version,
    installMode,
    pid: daemon.pid,
    pidAlive: daemon.pidAlive,
    ...(daemon.state !== undefined ? { state: daemon.state } : {}),
    ...(daemon.pidStale === true ? { pidStale: true } : {}),
    ...(daemon.detail !== undefined ? { detail: daemon.detail } : {}),
  };
  if (parsed.json) {
    emit(payload);
    return 0;
  }
  const processLine =
    daemon.pid === null
      ? 'not running'
      : daemon.pidAlive
        ? `running (pid ${daemon.pid}, state ${daemon.state ?? 'unknown'})`
        : `not running (stale pid ${daemon.pid})`;
  const lines = [
    `identity: ${identity !== null ? `bound (nodeId=${identity.nodeId})` : 'not bound'}`,
    ...(identity?.hubUrl ? [`hub:      ${identity.hubUrl}`] : []),
    `daemon:   ${processLine}`,
    `version:  ${version}`,
    `mode:     ${installMode}`,
    `dataDir:  ${dataDir}`,
    ...(daemon.detail !== undefined ? [`detail:   ${daemon.detail}`] : []),
  ];
  io.out(`${lines.join('\n')}\n`);
  return 0;
}
