/**
 * Launch the system browser at `url`. The `open` package is ESM-only and is
 * externalised under the CLI's CJS build, so it must be loaded lazily via a
 * dynamic `import()` rather than a top-level `require()`. Resolves `false`
 * (never throws) when the browser could not be launched — e.g. a headless
 * host — so callers can fall back to printing the URL.
 */
export async function openBrowser(url: string): Promise<boolean> {
  try {
    const mod = (await import('open')) as { default: (target: string) => Promise<unknown> };
    await mod.default(url);
    return true;
  } catch {
    return false;
  }
}
