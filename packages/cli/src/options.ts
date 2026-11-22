import process from 'node:process';
import { CliError } from './errors.js';

/** stdin abstraction used by commands like `ask` and secret prompts; tests inject stubs to avoid real process I/O. */
export interface StdinSource {
  /** Interactive terminal check: never read piped stdin under a TTY (prevents blocking indefinitely before EOF). */
  isTTY: boolean;
  /** Read all stdin content until EOF (only called when non-TTY). */
  readAll(): Promise<string>;
  /** Prompt for a secret interactively without echoing characters to the terminal (used when `isTTY` is true). */
  readSecret?(prompt: string): Promise<string>;
}

/** Injection hooks for runCli: tests override streams and fetch to avoid touching real process I/O. */
export interface RunCliOptions {
  env?: NodeJS.ProcessEnv;
  /** CLI process working directory (root for resolving local file paths); defaults to process.cwd(). Injected in tests to avoid process.chdir concurrency pollution. */
  cwd?: string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  fetch?: typeof fetch;
  stdin?: StdinSource;
}

export interface Io {
  env: NodeJS.ProcessEnv;
  out: (text: string) => void;
  err: (text: string) => void;
  fetchImpl: typeof fetch;
  stdin: StdinSource;
}

/** Read a secret interactively from a TTY in raw mode without echoing characters to the terminal. */
async function readSecretFromProcessTty(prompt: string): Promise<string> {
  if (process.stdin.isTTY !== true || typeof process.stdin.setRawMode !== 'function') {
    throw new CliError('interactive secret prompt requires a TTY', 'not_a_tty');
  }
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw === true;
  process.stderr.write(prompt);
  return await new Promise<string>((resolve, reject) => {
    const chars: string[] = [];
    const cleanup = (): void => {
      stdin.off('data', onData);
      stdin.off('end', onEnd);
      stdin.off('error', onError);
      try {
        stdin.setRawMode(wasRaw);
      } catch {
        // Ignore restore errors if stream already closed.
      }
      stdin.pause();
    };
    const finish = (value: string): void => {
      cleanup();
      process.stderr.write('\n');
      resolve(value);
    };
    const fail = (err: Error): void => {
      cleanup();
      process.stderr.write('\n');
      reject(err);
    };
    const onData = (chunk: Buffer | string): void => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      for (const ch of text) {
        if (ch === '\r' || ch === '\n' || ch === '\x04') {
          finish(chars.join(''));
          return;
        }
        if (ch === '\x03') {
          fail(new CliError('cancelled', 'aborted', 130));
          return;
        }
        if (ch === '\x7f' || ch === '\x08') {
          chars.pop();
          continue;
        }
        if (ch >= ' ') chars.push(ch);
      }
    };
    const onEnd = (): void => finish(chars.join(''));
    const onError = (err: Error): void => fail(err);
    try {
      stdin.setRawMode(true);
    } catch (err) {
      fail(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    stdin.resume();
    stdin.on('data', onData);
    stdin.on('end', onEnd);
    stdin.on('error', onError);
  });
}

/** Default stdin source: lazy TTY check (avoids touching process state at module load), then reads stdin to completion. */
function processStdin(): StdinSource {
  return {
    get isTTY(): boolean {
      return process.stdin.isTTY === true;
    },
    async readAll(): Promise<string> {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
      return Buffer.concat(chunks).toString('utf8');
    },
    readSecret: readSecretFromProcessTty,
  };
}

export function buildIo(options: RunCliOptions = {}): Io {
  return {
    env: options.env ?? process.env,
    out: options.stdout ?? ((text) => process.stdout.write(text)),
    err: options.stderr ?? ((text) => process.stderr.write(text)),
    // Defer resolving global fetch until invocation so tests can swap it cleanly
    fetchImpl: options.fetch ?? ((input, init) => fetch(input, init)),
    stdin: options.stdin ?? processStdin(),
  };
}
