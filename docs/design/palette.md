# Defigent palette: Mint Jelly

Decided on 2026-11-11. This palette replaces the violet accent `#6E54FF`, which is exactly Monad's primary color.

## Why mint

- **Own identity across chains.** The action color sits at ΔE 18.0 (OKLab, ×100) from the nearest chain brand color (Stellar teal `#00A7B5`), and further from Monad violet and Base blue. Above ~10 two colors read as clearly different. The old violet was at 0.0 from Monad.
- **Reads as trust.** Mint and jade read as "verified" and "safe", which is what Defigent sells.
- **Slime world.** Green is the classic slime color and sits well with the mascots.

## Tokens

| Token | Hex | Role |
|---|---|---|
| `--bg` | `#F6FAF8` | Page background. Barely tinted, never pure white, to cut glare. |
| `--surface` | `#FFFFFF` | Cards, popovers, inputs. |
| `--tint` | `#EAF6F0` | Tinted bands and section backgrounds. |
| `--line` | `#DDEBE4` | Decorative dividers and card borders. |
| `--line-strong` | `#6E9284` | Borders that identify a control, such as inputs (meets 3:1). |
| `--ink` | `#15302A` | Body text. Dark, but not black. |
| `--ink-2` | `#4C625C` | Secondary text. |
| `--mint-50` | `#CFF2E3` | Pastel surface: soft buttons, "verified" chips. |
| `--mint-300` | `#86DDB9` | Illustration and decorative fills. Only dark text on top. |
| `--jade-600` | `#0E7556` | The one action color: primary buttons, links, focus ring. |
| `--jade-700` | `#0B5F46` | Hover and pressed state of the primary button. |
| `--warn-bg` / `--warn-ink` | `#FFF1DC` / `#8A4206` | Warnings. |
| `--danger-bg` / `--danger-ink` | `#FDE2E1` / `#9B1C1C` | Errors and flagged clones. |

```css
:root {
  --bg: #F6FAF8; --surface: #FFFFFF; --tint: #EAF6F0;
  --line: #DDEBE4; --line-strong: #6E9284;
  --ink: #15302A; --ink-2: #4C625C;
  --mint-50: #CFF2E3; --mint-300: #86DDB9;
  --jade-600: #0E7556; --jade-700: #0B5F46;
  --warn-bg: #FFF1DC; --warn-ink: #8A4206;
  --danger-bg: #FDE2E1; --danger-ink: #9B1C1C;
}
```

## Rules

1. **Pastel for surfaces, the deep tone for text and buttons.** A pastel never carries text on its own: white on `--mint-50` is 1.20:1.
2. **One action color.** `--jade-600` is the only color that means "click here".
3. **Green means verified.** Use jade and mint for verified and trusted states, and nothing else that could be mistaken for them.
4. **Status never relies on color alone.** Always pair it with an icon or a word (✓ Verified, ⚠ Flagged), so it still works for color-blind users.
5. **The slimes carry the rainbow.** The interface chrome stays mint and neutral. The mascots keep their approved colors.

## Contrast (WCAG 2.x)

All 18 checked pairs pass. Text needs 4.5:1; control borders and focus rings need 3:1.

| Pair | Ratio |
|---|---|
| Body text on page / card / tinted band | 13.41 / 14.11 / 12.73 |
| Secondary text on page / card / tinted band | 6.22 / 6.54 / 5.90 |
| Link on page / card / tinted band | 5.39 / 5.68 / 5.12 |
| Primary button label (white on jade-600 / jade-700) | 5.68 / 7.67 |
| Soft button or verified chip (jade-600 on mint-50) | 4.72 |
| Dark text on mint-300 | 8.77 |
| Warning chip / danger chip | 6.59 / 6.65 |
| Focus ring vs page | 5.39 |
| Input border vs card / page | 3.44 / 3.27 |

## Applying it later

- The spike's drop shadows and glows are violet-tinted (`rgba(91,64,240,…)` and `rgba(110,84,255,…)`). Retint them to jade when the palette lands.
- Pip, the teal mascot, is the closest to the brand color and a natural brand ambassador.
- Starting point for an Astryx theme. Only `color.accent`, `typography.body` and `typography.heading` are confirmed by the docs read so far, so check every key with `astryx docs theme` once Astryx is installed:

```ts
export const defigentTheme = defineTheme({
  name: 'defigent-mint-jelly',
  color: { accent: '#0E7556' },
  typography: {
    body: { family: 'Figtree', fallbacks: 'system-ui, sans-serif' },
    heading: { family: 'Bricolage Grotesque', fallbacks: 'Figtree, sans-serif' },
  },
});
```

Astryx never loads font files, so the app has to load Figtree, Bricolage Grotesque and JetBrains Mono itself.
