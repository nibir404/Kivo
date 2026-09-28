/**
 * The demo project (@kivo/seed-project) for the in-browser demo. Bundled at build time by the
 * `kivo-seed-project` Vite plugin and loaded lazily: it only downloads the first time the demo
 * is opened in this browser.
 */
export async function demoFiles(): Promise<Record<string, string>> {
  const files = (await import("virtual:kivo-seed-project")).default
  // The daemon adds the same .gitignore when it copies the demo to disk.
  return { ...files, ".gitignore": ".venv/\n__pycache__/\n.pytest_cache/\n*.db\n.env\n" }
}
