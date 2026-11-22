/** Unified CLI error: `code` for `--json` programmatic consumption; non-zero `exitCode` indicates failure. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly code: string = 'cli_error',
    readonly exitCode = 1,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

export interface DescribedError {
  message: string;
  code: string;
  exitCode: number;
  details?: unknown;
}

export function describeError(error: unknown): DescribedError {
  if (error instanceof CliError) {
    return { message: error.message, code: error.code, exitCode: error.exitCode, details: error.details };
  }
  if (error instanceof Error) return { message: error.message, code: 'internal_error', exitCode: 1 };
  return { message: String(error), code: 'internal_error', exitCode: 1 };
}

/** Envelope matching Hub HTTP error responses: `{ error: { code, message, details? } }`. */
export function errorEnvelope(error: DescribedError): { error: { code: string; message: string; details?: unknown } } {
  const inner: { code: string; message: string; details?: unknown } = {
    code: error.code,
    message: error.message,
  };
  if (error.details !== undefined) inner.details = error.details;
  return { error: inner };
}

const ERROR_HINTS: Readonly<Record<string, string>> = {
  hub_unreachable: 'Ensure the Hub is running ("helmx start") or check HELMX_HUB_URL.',
  unauthorized: 'Run "helmx login" (or "helmx setup" for first-time setup) or set HELMX_TOKEN.',
  node_offline: 'Check node connectivity with "helmx nodes list" or run "helmx-node doctor" on the target machine.',
  node_draining: 'The target node is draining for an upgrade; retry shortly.',
  hub_starting: 'The Hub is still starting up; retry shortly.',
  plugin_has_live_tasks: 'Wait for active plugin tasks to finish or abort them before retrying.',
  plugin_in_use: 'Pass --force to bypass persistent resource warnings, or remove those resources first.',
  conversation_managed_by_plugin: 'This conversation is owned by a plugin; manage or close it through that plugin.',
  current_conversation_missing: 'Pass an explicit conversation <id> or set HELMX_CONVERSATION_ID.',
  current_node_missing: 'Pass an explicit <nodeId> or set HELMX_NODE_ID.',
  missing_build: 'Run "pnpm build" in the repository root before installing the OS service.',
  credentials_unreadable: 'Inspect or remove the cli-token file and run "helmx login".',
};

function summarizeErrorDetails(details: unknown, message: string): string | undefined {
  if (details === undefined || details === null) return undefined;
  if (typeof details === 'string' || typeof details === 'number' || typeof details === 'boolean') {
    const s = String(details);
    return message.includes(s) ? undefined : s;
  }
  if (Array.isArray(details)) {
    if (details.length === 0) return undefined;
    const preview = details.slice(0, 5).map((item) => (typeof item === 'string' ? item : JSON.stringify(item)));
    const suffix = details.length > 5 ? ` (+${details.length - 5} more)` : '';
    return `${preview.join(', ')}${suffix}`.slice(0, 240);
  }
  if (typeof details === 'object') {
    const entries = Object.entries(details as Record<string, unknown>).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return undefined;
    const parts: string[] = [];
    for (const [k, v] of entries.slice(0, 8)) {
      const rendered =
        typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
          ? String(v)
          : JSON.stringify(v);
      const compact = rendered.length > 80 ? `${rendered.slice(0, 77)}...` : rendered;
      parts.push(`${k}=${compact}`);
    }
    if (entries.length > 8) parts.push(`+${entries.length - 8} more`);
    return parts.join(', ');
  }
  return undefined;
}

/**
 * Format a structured human-readable diagnostic block (`error [<code>]: <message>` + concise details + recovery hint).
 * Machine-readable `--json` callers use `errorEnvelope()` untouched.
 */
export function formatHumanError(error: DescribedError): string {
  const lines = [`error [${error.code}]: ${error.message}`];
  const detailLine = summarizeErrorDetails(error.details, error.message);
  if (detailLine !== undefined) {
    lines.push(`  details: ${detailLine}`);
  }
  const hint = ERROR_HINTS[error.code];
  if (hint !== undefined) {
    // Avoid duplicating a hint whose key command is already in the error message.
    const alreadyHinted =
      (error.code === 'unauthorized' && error.message.includes('helmx login')) ||
      (error.code === 'plugin_in_use' && error.message.includes('--force'));
    if (!alreadyHinted) lines.push(`  hint: ${hint}`);
  }
  return `${lines.join('\n')}\n`;
}
