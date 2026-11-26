/**
 * Enable-time global uniqueness across all active plugins (plus the pending `pluginId`):
 * - Tool names (`ctx.tool` and `exposeAsTool` resolved names/aliases) must be globally unique and
 *   must not collide with `KERNEL_TOOL_NAMES` (`409 duplicate_tool_name`);
 * - CLI-exposed action command paths must not exact- or prefix-collide with `CORE_CLI_COMMAND_PATHS`
 *   or another active plugin's CLI command (`409 duplicate_cli_command`).
 *
 * Called by `PluginHost` during enable preflight and at the synchronous enable commit point so
 * disabled pre-registrations never occupy global names and conflicting commits roll back cleanly.
 * Plugins are swept in the given order (pending plugin last); within a plugin, direct tools are
 * claimed before its actions so the first conflict reported matches registration order.
 */
import { HelmxError } from '@helmx/protocol';
import {
  CORE_CLI_COMMAND_SEGMENT_LIST,
  KERNEL_TOOL_NAME_SET,
  cliPathsConflict,
  resolveActionCliCommand,
  type SiblingActionView,
} from '../action-validation.js';
import type { ActionRegistry } from './action-registry.js';
import type { ToolRegistry } from './tool-registry.js';

interface CliOwner {
  pluginId: string;
  actionId: string;
  command: readonly string[];
}

function claimToolName(toolOwners: Map<string, string>, toolName: string, owner: { pluginId: string; actionId?: string }): void {
  const subject = owner.actionId === undefined ? `tool "${toolName}"` : `action ${owner.actionId} tool name "${toolName}"`;
  const origin = { pluginId: owner.pluginId, ...(owner.actionId !== undefined ? { actionId: owner.actionId } : {}) };
  if (KERNEL_TOOL_NAME_SET.has(toolName)) {
    throw new HelmxError(
      'duplicate_tool_name',
      `Plugin ${owner.pluginId} ${subject} conflicts with built-in kernel tool "${toolName}"`,
      409,
      { ...origin, toolName, owner: 'kernel' },
    );
  }
  const prev = toolOwners.get(toolName);
  if (prev !== undefined) {
    throw new HelmxError(
      'duplicate_tool_name',
      `Plugin ${owner.pluginId} ${subject} conflicts with plugin ${prev}`,
      409,
      { ...origin, toolName, ownerPluginId: prev },
    );
  }
  toolOwners.set(toolName, owner.pluginId);
}

function claimCliCommand(cliOwners: CliOwner[], ownerPluginId: string, action: SiblingActionView): void {
  const cliCommand = resolveActionCliCommand(ownerPluginId, action.id, action.visibility, action.cli);
  if (cliCommand === undefined) return;
  for (const corePath of CORE_CLI_COMMAND_SEGMENT_LIST) {
    if (cliPathsConflict(corePath, cliCommand)) {
      throw new HelmxError(
        'duplicate_cli_command',
        `Plugin ${ownerPluginId} action ${action.id} CLI command "helmx ${cliCommand.join(' ')}" conflicts with core CLI command "helmx ${corePath.join(' ')}"`,
        409,
        {
          pluginId: ownerPluginId,
          actionId: action.id,
          command: [...cliCommand],
          conflictingCommand: [...corePath],
          owner: 'core',
        },
      );
    }
  }
  for (const prev of cliOwners) {
    if (cliPathsConflict(prev.command, cliCommand)) {
      throw new HelmxError(
        'duplicate_cli_command',
        `Plugin ${ownerPluginId} action ${action.id} CLI command "helmx ${cliCommand.join(' ')}" conflicts with plugin ${prev.pluginId} action ${prev.actionId} ("helmx ${prev.command.join(' ')}")`,
        409,
        {
          pluginId: ownerPluginId,
          actionId: action.id,
          command: [...cliCommand],
          ownerPluginId: prev.pluginId,
          conflictingActionId: prev.actionId,
          conflictingCommand: [...prev.command],
        },
      );
    }
  }
  cliOwners.push({ pluginId: ownerPluginId, actionId: action.id, command: cliCommand });
}

export function assertCrossPluginUnique(
  actions: ActionRegistry,
  tools: ToolRegistry,
  pluginId: string,
  activePluginIds: Iterable<string>,
): void {
  const toolOwners = new Map<string, string>();
  const cliOwners: CliOwner[] = [];

  const sweep = (ownerPluginId: string): void => {
    for (const toolName of tools.entriesOf(ownerPluginId).keys()) {
      claimToolName(toolOwners, toolName, { pluginId: ownerPluginId });
    }
    for (const action of actions.entriesOf(ownerPluginId).values()) {
      if (action.exposeAsTool) {
        claimToolName(toolOwners, action.toolAlias, { pluginId: ownerPluginId, actionId: action.id });
      }
      claimCliCommand(cliOwners, ownerPluginId, action);
    }
  };

  for (const activeId of activePluginIds) {
    if (activeId === pluginId) continue;
    sweep(activeId);
  }
  sweep(pluginId);
}
