/**
 * Shim host — dario-side of the shim transport.
 *
 * Runs `dario shim -- <cmd> [args...]`. Spawns the child with NODE_OPTIONS
 * pointing at the shim runtime, listens on a unix socket (or named pipe on
 * Windows) for billing relay events from the runtime, feeds them into the
 * Analytics class, and forwards the child's stdio to the host TTY so the
 * user experience is identical to running the command directly.
 *
 * Why a socket and not a file or stdout: the runtime patches `globalThis.fetch`
 * inside the *child*'s process — that child still owns its own stdout (the
 * user's TTY), and we don't want shim relay traffic interleaved with CC's
 * normal output. A unix socket gives us a clean side-channel, lets the host
 * keep accumulating analytics across the child's lifetime, and stays open if
 * the child re-execs (rare but possible with claude wrappers).
 *
 * See v3.12.0 CHANGELOG for the design rationale.
 */

import { createServer, type Server, type Socket } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Analytics } from './../analytics.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Locate the shim runtime CJS file. In the published package it lives at
 * `dist/shim/runtime.cjs` next to this module's compiled output. In dev
 * (running via tsx from src/) it lives at `src/shim/runtime.cjs`.
 */
export function locateShimRuntime(): string {
  const candidates = [
    join(__dirname, 'runtime.cjs'),                    // dist/shim/runtime.cjs (production)
    join(__dirname, '..', '..', 'src', 'shim', 'runtime.cjs'), // dev: from dist/shim → ../../src/shim
    join(__dirname, '..', 'src', 'shim', 'runtime.cjs'),       // dev: from src/shim → ../src/shim (rare)
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(`shim runtime not found; checked: ${candidates.join(', ')}`);
}

interface RelayEvent {
  kind: 'request' | 'response';
  timestamp: number;
  bytes?: number;
  status?: number;
  claim?: string | null;
  overageUtil?: number | null;
}

export interface ShimHostOptions {
  /** Command to spawn (the user's claude binary, or any node-based CC wrapper). */
  command: string;
  /** Args passed through to the child. */
  args: string[];
  /** Override the template path the runtime reads. Defaults to ~/.dario/cc-template.live.json. */
  templatePath?: string;
  /** Print per-event lines to stderr. */
  verbose?: boolean;
  /** Optional Analytics sink. If omitted, a fresh instance is created. */
  analytics?: Analytics;
}

export interface ShimHostResult {
  exitCode: number;
  events: RelayEvent[];
  analytics: Analytics;
}

/**
 * Pick a socket path: unix domain socket on POSIX, named pipe on Windows.
 * Both forms are accepted directly by net.createServer / net.connect.
 */
function makeSockPath(): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\dario-shim-${process.pid}-${Date.now()}`;
  }
  const dir = mkdtempSync(join(tmpdir(), 'dario-shim-'));
  return join(dir, 'sock');
}

/**
 * Build the child env. We *prepend* our --require to NODE_OPTIONS rather than
 * overwrite, so existing user NODE_OPTIONS (debuggers, source maps, tracers)
 * still apply. Quoting paths defends against spaces in the dario install dir.
 */
function buildChildEnv(
  parentEnv: NodeJS.ProcessEnv,
  runtimePath: string,
  sockPath: string,
  templatePath: string,
  verbose: boolean,
): NodeJS.ProcessEnv {
  const requireFlag = `--require=${JSON.stringify(runtimePath)}`;
  const existing = parentEnv.NODE_OPTIONS ?? '';
  const NODE_OPTIONS = existing ? `${requireFlag} ${existing}` : requireFlag;
  return {
    ...parentEnv,
    NODE_OPTIONS,
    DARIO_SHIM: '1',
    DARIO_SHIM_SOCK: sockPath,
    DARIO_SHIM_TEMPLATE: templatePath,
    ...(verbose ? { DARIO_SHIM_VERBOSE: '1' } : {}),
  };
}

/** Stream parser: relay events arrive as newline-delimited JSON over the socket. */
function makeSocketHandler(
  events: RelayEvent[],
  analytics: Analytics,
  verbose: boolean,
): (sock: Socket) => void {
  return (sock: Socket) => {
    let buf = '';
    sock.setEncoding('utf-8');
    sock.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const event = JSON.parse(line) as RelayEvent;
          events.push(event);
          if (event.kind === 'response') {
            // Synthesize a minimal RequestRecord so this surfaces in /analytics.
            // Token counts aren't available from the shim transport — the runtime
            // would need to parse the SSE stream to extract them, which we
            // explicitly chose not to do (it's expensive and intrusive). So this
            // is a request-count + claim-tracking record, not a token-cost record.
            analytics.record({
              timestamp: event.timestamp ?? Date.now(),
              account: 'shim',
              model: 'unknown',
              inputTokens: 0, outputTokens: 0,
              cacheReadTokens: 0, cacheCreateTokens: 0, thinkingTokens: 0,
              claim: event.claim ?? '',
              util5h: 0, util7d: 0,
              overageUtil: event.overageUtil ?? 0,
              latencyMs: 0,
              status: event.status ?? 0,
              isStream: false,
              isOpenAI: false,
            });
          }
          if (verbose) {
            process.stderr.write(`[dario shim] ${JSON.stringify(event)}\n`);
          }
        } catch {
          // Malformed line — drop silently. The runtime is best-effort.
        }
      }
    });
  };
}

/** Internal: stand up the socket server and resolve when it's listening. */
function startSocketServer(
  sockPath: string,
  events: RelayEvent[],
  analytics: Analytics,
  verbose: boolean,
): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer(makeSocketHandler(events, analytics, verbose));
    server.once('error', reject);
    server.listen(sockPath, () => resolve(server));
  });
}

/**
 * Spawn the child command with the shim runtime injected, relay billing
 * events to Analytics, return when the child exits.
 *
 * Stdio is inherited so the user sees the child's output exactly as if they
 * had run it without the shim.
 */
export async function runShim(opts: ShimHostOptions): Promise<ShimHostResult> {
  const runtimePath = locateShimRuntime();
  const sockPath = makeSockPath();
  const templatePath = opts.templatePath ?? join(homedir(), '.dario', 'cc-template.live.json');
  const verbose = opts.verbose ?? false;
  const analytics = opts.analytics ?? new Analytics();
  const events: RelayEvent[] = [];

  const server = await startSocketServer(sockPath, events, analytics, verbose);

  let child: ChildProcess;
  try {
    child = spawn(opts.command, opts.args, {
      stdio: 'inherit',
      env: buildChildEnv(process.env, runtimePath, sockPath, templatePath, verbose),
    });
  } catch (e) {
    server.close();
    throw e;
  }

  const exitCode: number = await new Promise((resolve) => {
    child.on('exit', (code, signal) => {
      if (signal) resolve(128 + (signal === 'SIGTERM' ? 15 : 1));
      else resolve(code ?? 0);
    });
    child.on('error', () => resolve(1));
  });

  // Give any in-flight relay writes a brief window to land before tearing down.
  await new Promise((r) => setTimeout(r, 50));
  server.close();

  return { exitCode, events, analytics };
}
