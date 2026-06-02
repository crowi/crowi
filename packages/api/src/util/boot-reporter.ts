/**
 * TTY-aware boot reporter (feature-boot-progress-ui, Part 1).
 *
 * Wraps the existing `step()` boot sequence in `crowi/index.ts` and groups
 * the 13 init steps + the server start steps into four layers
 * (core / config / services / server). Each layer is shown as:
 *
 *   - TTY:     a live spinner that resolves to `✓ <layer>  (Nms)` and a final
 *              `🚀 API ready <url>` banner.
 *   - non-TTY: a structured, grep-able one-line log per layer
 *              (`[boot] core ok (412ms)`), no cursor control / re-draw.
 *
 * In both modes a machine-readable readiness marker
 * (`@@crowi:ready api <url>`) is emitted on exactly one line when boot
 * finishes — this is the only contract `scripts/dev.mjs` depends on, kept
 * separate from the human-facing banner so wording can change freely.
 *
 * The reporter is intentionally `debug`-independent: it writes to stdout
 * directly so operators see boot progress without `DEBUG=crowi:*`. When
 * `DEBUG` is set we degrade to plain mode (see {@link createBootReporter}) so
 * spinner re-draws never interleave with debug output.
 *
 * Pure helpers (marker formatting/parsing, plain-line formatting, duration
 * formatting, spinner frame, ANSI escapes) are exported so they can be
 * unit-tested without a real TTY.
 */

/** Boot layers, in execution order. */
export type BootLayer = 'core' | 'config' | 'services' | 'server';

/** Stable, machine-readable readiness marker prefix. Shared contract with `scripts/dev.mjs`. */
export const READY_MARKER_PREFIX = '@@crowi:ready';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;
const SPINNER_INTERVAL_MS = 80;

const LAYER_LABELS: Record<BootLayer, string> = {
  core: 'core      (encryption · database · models · redis)',
  config: 'config    (load · migrations · oauth seed)',
  services: 'services  (renderer · plugins · mailer · slack)',
  server: 'server    (build · attach · listen)',
};

// ── pure helpers (unit-tested) ──────────────────────────────────────────────

/** ANSI escape fragments — bundled so tests can assert on exact bytes. */
export const ANSI = {
  hideCursor: '\x1b[?25l',
  showCursor: '\x1b[?25h',
  clearLine: '\x1b[2K',
  cursorStart: '\r',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m',
  reset: '\x1b[0m',
} as const;

/** Format a duration as a compact `(Nms)` / `(N.Ns)` token. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Spinner frame for a given tick (wraps around the frame list). */
export function spinnerFrame(tick: number): string {
  return SPINNER_FRAMES[tick % SPINNER_FRAMES.length];
}

/** Build the `@@crowi:ready <service> <url>` marker line (no trailing newline). */
export function formatReadyMarker(service: string, url: string): string {
  return `${READY_MARKER_PREFIX} ${service} ${url}`;
}

/**
 * Parse a `@@crowi:ready <service> <url>` marker out of an arbitrary output
 * line (it may be prefixed by turbo's `api:dev: ` etc.). Returns null when the
 * line carries no marker. Shared logic mirrored in `scripts/dev.mjs`.
 */
export function parseReadyMarker(line: string): { service: string; url: string } | null {
  const idx = line.indexOf(READY_MARKER_PREFIX);
  if (idx === -1) return null;
  const rest = line.slice(idx + READY_MARKER_PREFIX.length).trim();
  const [service, url] = rest.split(/\s+/);
  if (!service || !url) return null;
  return { service, url };
}

/** Non-TTY structured layer line: `[boot] core ok (412ms)`. */
export function formatPlainLayerLine(layer: BootLayer, ms: number): string {
  return `[boot] ${layer} ok (${formatDuration(ms)})`;
}

/** Non-TTY final line: `[boot] ready in 1.2s` (total boot time). */
export function formatPlainReadyLine(totalMs: number): string {
  return `[boot] ready in ${formatDuration(totalMs)}`;
}

// ── reporter ────────────────────────────────────────────────────────────────

export interface BootReporter {
  /** Start a layer (begins the spinner in TTY mode). */
  beginLayer(layer: BootLayer): void;
  /** Mark the active layer done and print its elapsed time. */
  endLayer(): void;
  /**
   * Emit a warning/error line without corrupting the live spinner: clears the
   * current spinner line, writes the message, then re-arms the spinner.
   */
  note(write: () => void): void;
  /**
   * Finish boot: stops any spinner, prints the human banner + the machine
   * readiness marker. `service`/`url` feed the marker; `url` also the banner.
   */
  finish(service: string, url: string): void;
  /**
   * Idempotent teardown for the failure path: stops any running spinner,
   * clears the current spinner line and restores the cursor. Safe to call
   * multiple times (e.g. from a try/finally *and* from `exitOnError`). Must run
   * before a fatal `console.error` so the spinner doesn't overwrite the stack
   * trace and the hidden cursor is restored before the process exits.
   */
  dispose(): void;
}

export interface CreateBootReporterOptions {
  /** Output sink. Defaults to `process.stdout`. */
  stream?: NodeJS.WriteStream;
  /** Force TTY/plain mode (tests). Defaults to `stream.isTTY`. */
  isTTY?: boolean;
  /**
   * When DEBUG is active, plain mode is forced so spinner re-draws don't
   * interleave with debug output. Defaults to reading `process.env.DEBUG`.
   */
  debugEnabled?: boolean;
}

/**
 * Construct the boot reporter. In TTY mode it animates a spinner per layer; in
 * plain mode (non-TTY, or `DEBUG` set) it emits one structured line per layer.
 */
export function createBootReporter(options: CreateBootReporterOptions = {}): BootReporter {
  const stream = options.stream ?? process.stdout;
  const debugEnabled = options.debugEnabled ?? Boolean(process.env.DEBUG);
  // Graceful degrade: spinner only when we own a real TTY *and* DEBUG isn't
  // flooding the same stream.
  const tty = (options.isTTY ?? Boolean(stream.isTTY)) && !debugEnabled;

  const bootStart = Date.now();
  let layerStart = 0;
  let activeLayer: BootLayer | null = null;
  let tick = 0;
  let timer: ReturnType<typeof setInterval> | null = null;

  const write = (s: string): void => {
    stream.write(s);
  };

  const drawSpinner = (): void => {
    if (!activeLayer) return;
    write(`${ANSI.cursorStart}${ANSI.clearLine}${ANSI.cyan}${spinnerFrame(tick)}${ANSI.reset} ${LAYER_LABELS[activeLayer]}`);
    tick += 1;
  };

  const stopSpinner = (): void => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  // Hide the cursor, draw the first frame, and arm the redraw interval for the
  // current `activeLayer`. Shared by `beginLayer` (initial) and `note` (re-arm
  // after temporarily clearing the line to print a message).
  const startSpinner = (): void => {
    write(ANSI.hideCursor);
    drawSpinner();
    timer = setInterval(drawSpinner, SPINNER_INTERVAL_MS);
  };

  const beginLayer = (layer: BootLayer): void => {
    activeLayer = layer;
    layerStart = Date.now();
    tick = 0;
    if (tty) startSpinner();
  };

  const endLayer = (): void => {
    if (!activeLayer) return;
    const elapsed = Date.now() - layerStart;
    if (tty) {
      stopSpinner();
      write(
        `${ANSI.cursorStart}${ANSI.clearLine}${ANSI.green}✓${ANSI.reset} ${LAYER_LABELS[activeLayer]} ${ANSI.dim}(${formatDuration(elapsed)})${ANSI.reset}\n`,
      );
      write(ANSI.showCursor);
    } else {
      write(`${formatPlainLayerLine(activeLayer, elapsed)}\n`);
    }
    activeLayer = null;
  };

  const note = (writeFn: () => void): void => {
    if (tty && timer) {
      stopSpinner();
      write(`${ANSI.cursorStart}${ANSI.clearLine}`);
      write(ANSI.showCursor);
      writeFn();
      // Re-arm the spinner for the still-running layer.
      startSpinner();
    } else {
      writeFn();
    }
  };

  const finish = (service: string, url: string): void => {
    // Defensive: make sure no spinner is left running.
    if (activeLayer) endLayer();
    stopSpinner();
    const total = Date.now() - bootStart;
    if (tty) {
      write(`${ANSI.bold}${ANSI.green}🚀 API ready${ANSI.reset}  ${ANSI.cyan}${url}${ANSI.reset}  ${ANSI.dim}(${formatDuration(total)})${ANSI.reset}\n`);
    } else {
      write(`${formatPlainReadyLine(total)}\n`);
    }
    // Machine-readable marker — always on its own line, TTY or not.
    write(`${formatReadyMarker(service, url)}\n`);
  };

  let disposed = false;
  const dispose = (): void => {
    // Idempotent: a try/finally around the boot steps *and* `exitOnError` may
    // both call this. After the first run there's no spinner/cursor state left
    // to clean up, so subsequent calls are no-ops (and never re-emit ANSI).
    if (disposed) return;
    disposed = true;
    const spinning = timer !== null;
    stopSpinner();
    if (tty && spinning) {
      // Wipe the half-drawn spinner line so a following console.error stack
      // starts clean, and restore the cursor we hid in startSpinner().
      write(`${ANSI.cursorStart}${ANSI.clearLine}`);
      write(ANSI.showCursor);
    }
    activeLayer = null;
  };

  return { beginLayer, endLayer, note, finish, dispose };
}
