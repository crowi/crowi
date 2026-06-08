---
'@crowi/api-contract': minor
'@crowi/api': minor
'@crowi/web': minor
---

Add a light / dark / system theme switch. The app already shipped a full set
of `.dark` design tokens but had no way to activate them; this wires them up
and covers the rendering that lives outside the token system.

- **Theme toggle** — a system / light / dark switch in the header user menu
  and on the sign-in screen (next to the language switcher), backed by
  `next-themes` (`class` strategy, `system` default). The selection persists
  and is applied before hydration, so there is no flash of the wrong theme on
  reload (no FOUC, no hydration warning). `system` follows the OS setting.
- **Token-driven UI** — activating `.dark` switches the whole shadcn +
  `--crowi-*` surface (background, text, borders, buttons, alerts, avatars,
  header, sidebar) and `color-scheme` aligns native UI (scrollbars, form
  controls) to the theme.
- **Outside-the-tokens rendering** — Shiki code blocks render dual-theme via
  CSS variables (`--shiki-light` / `--shiki-dark`) so highlighting follows the
  theme; the CodeMirror editor, the page-history diff viewer, and sonner
  toasts all track the active theme. KaTeX inherits `currentColor`.
- **Cross-device persistence** — the chosen theme is stored on the user
  account (`User.theme`) via a dedicated `PATCH /me/theme` and reconciled on
  load, so the preference follows the user across devices rather than living
  only in per-device localStorage.
- **Fixed-colour diagrams** — server-generated PlantUML (and future Mermaid)
  SVGs keep their baked-in colours; under dark mode they are wrapped in a
  neutral light background so they stay legible.
