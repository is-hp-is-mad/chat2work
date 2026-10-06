---
name: html-report
description: Build a self-contained HTML report, dashboard or interactive page that opens straight in a browser with no build step and no network access. Use for visual deliverables, data dashboards and anything the user wants to click through.
version: 1.0.0
---

# Self-contained HTML

The deliverable is **one `.html` file** that works when double-clicked, offline.
No bundler, no `npm install`, no CDN that might be blocked. Write it to the
Artifacts folder and open it with `Artifact(action: "open", …)`.

## Structure

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>…</title>
<style>/* all CSS here */</style>
</head>
<body>
  …
<script>/* all JS here, data inlined as a JS literal */</script>
</body>
</html>
```

Inline the data. `fetch('data.json')` fails from `file://` in every browser.

```js
const DATA = /* JSON.dumps(records) written in by Python */;
```

## Making it not look generated

- **Pick a type scale and stick to it** — e.g. 13 / 15 / 20 / 32 px, nothing in
  between. Arbitrary sizes are the clearest tell of machine-written CSS.
- **One accent colour.** Neutrals carry the layout; the accent marks the one
  thing that matters on each screen.
- **Space is structure.** Generous, consistent padding (a single spacing scale:
  4 / 8 / 16 / 24 / 48) does more for legibility than borders and boxes.
- **No nested cards.** A card inside a card inside a panel reads as clutter.
- **System font stack** unless the user asked for a typeface:
  `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`.
- **Dark mode via `prefers-color-scheme`** costs ten lines and is always
  noticed.

```css
:root { color-scheme: light dark; --bg:#fff; --fg:#16181d; --muted:#6b7280; --accent:#1f3864; --line:#e5e7eb; }
@media (prefers-color-scheme: dark) {
  :root { --bg:#111318; --fg:#e8eaed; --muted:#9aa0a6; --accent:#8ab4f8; --line:#2a2d34; }
}
body { background: var(--bg); color: var(--fg); margin: 0; font: 15px/1.6 system-ui, sans-serif; }
```

## Charts without a library

For simple charts, hand-written SVG beats pulling in a charting library — it is
smaller, styleable with the same CSS variables, and cannot fail to load.

```js
const w = 720, h = 280, pad = 40;
const x = i => pad + i * (w - pad * 2) / (DATA.length - 1);
const y = v => h - pad - (v - min) * (h - pad * 2) / (max - min);
const d = DATA.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(p.value)}`).join(' ');
```

If you genuinely need a full charting library, vendor it: download the minified
source with `WebFetch` or `Bash`, and paste it into the `<script>` block.

## Interactivity

Plain DOM APIs are enough for filters, sorting and tabs. Keep state in one
object and re-render from it; do not mutate the DOM from six places.

## Before you hand it over

Open the file (`Artifact(action: "open")`) and confirm it renders. If the page
is meant to be printed, add a `@media print` block that hides controls and
forces a light palette.
