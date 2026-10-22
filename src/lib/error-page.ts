/**
 * The page the server sends when rendering failed before the app could (the
 * same words as A31's crash page, `components/error-page.tsx`), with no
 * script of ours and nothing from the app's bundle.
 */
export function renderErrorPage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Something went wrong on this page</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light dark" />
    <style>
      :root { color-scheme: light dark; --bg: #ffffff; --ink: #15171c; --muted: #626671; --border: #d7d9df; --dot: #b42318; }
      @media (prefers-color-scheme: dark) { :root { --bg: #0f1012; --ink: #ececef; --muted: #9a9ca5; --border: #2d2e35; --dot: #f0695a; } }
      body { font: 14px/1.45 "Geist", ui-sans-serif, system-ui, sans-serif; background: var(--bg); color: var(--ink); display: grid; place-items: center; min-height: 100vh; margin: 0; padding: 1.5rem; }
      .card { max-width: 420px; width: 100%; text-align: center; }
      .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--dot); margin-bottom: 16px; }
      h1 { font-size: 16px; font-weight: 600; margin: 0 0 8px; }
      p { color: var(--muted); margin: 0 0 20px; }
      .actions { display: flex; gap: 8px; justify-content: center; flex-wrap: wrap; }
      a, button { height: 32px; padding: 0 12px; border-radius: 6px; font: 500 14px/32px inherit; cursor: pointer; text-decoration: none; border: 1px solid var(--border); background: var(--bg); color: var(--ink); }
      .primary { background: var(--ink); color: var(--bg); border-color: var(--ink); }
    </style>
  </head>
  <body>
    <div class="card">
      <span class="dot" aria-hidden="true"></span>
      <h1>Something went wrong on this page</h1>
      <p>Nothing you did was lost; threads and documents are saved as they go. Reloading usually fixes it.</p>
      <div class="actions">
        <button class="primary" onclick="location.reload()">Reload</button>
        <a href="/app">Go home</a>
      </div>
    </div>
  </body>
</html>`;
}
