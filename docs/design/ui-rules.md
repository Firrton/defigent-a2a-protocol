# UI rules

Decided on 2026-11-13. The React 19 + Vite migration builds on **Astryx** (`@astryxdesign/core`). We adopt the rules of Vercel's ui-sdk skill (github.com/vercel-labs/ui, reviewed at commit `8ff6bcf`) as working discipline, but we do **not** install the ui-sdk library.

## Why not the ui-sdk library

- **It overlaps Astryx.** Using both for the same controls (dialogs, tabs, menus) means two component systems with two styling models.
- **It is too new.** `@ui-sdk/core` 0.1.0-beta.1 was first published on 2026-11-12, and the repo is marked beta.
- **Its best feature is not usable yet.** Its agent bridge (`createAgent`, WebMCP) needs `document.modelContext`, which most browsers do not ship yet. That bridge also reads ui-sdk components, not Astryx ones.

**Revisit** agent-ready UI when ui-sdk leaves beta or browsers ship WebMCP. For a platform built for agents, letting agents operate the dashboard by name is a real differentiator.

## Rules

1. **Use what Astryx ships.** Before writing any `role=` attribute, look for the Astryx component. A hand-rolled `div` with `role="dialog"`, `"menu"`, `"listbox"`, `"tablist"`, `"switch"` or `"slider"` is almost always a bug.
2. **Name every control.** Use the component's visible label, or `aria-label` when there is no visible text. Screen readers and AI agents both find controls by name.
3. **Style state through the component.** Use the state attributes and CSS variables the component documents, or the Astryx theme tokens. Never use inline styles for state, and never select on generated ids.
4. **Contrast follows the palette.** Text needs 4.5:1 against what is behind it; control edges, focus rings and state fills need 3:1. Tokens and measured pairs are in [palette.md](palette.md). jsdom cannot see color, so check it in a real browser.
5. **Key lists by id or value,** never by index.
6. **Comments are rare.** Write one only when a reader would get the code wrong without it, like a browser quirk or a trade-off, in one or two lines.
7. **Test every interactive piece** for keyboard use, focus and accessible names, not only for clicks.

## Tooling

- **pnpm only.** Install with `pnpm add`, run binaries with `pnpm exec` (for example `pnpm exec tsc -b`), never `npm` or `npx`.
- **Pin exact versions** of UI packages and review the lockfile diff when they change.
- **No unpinned remote scripts.** Bundle dependencies instead of loading them from a vendor's domain at runtime.
- **Astryx never loads fonts.** The app loads Figtree, Bricolage Grotesque and JetBrains Mono itself.
