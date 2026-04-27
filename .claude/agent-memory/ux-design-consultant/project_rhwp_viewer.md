---
name: Project — rhwp-viewer PWA
description: Mobile-first HWP/HWPX viewer PWA; tech stack, design system, accessibility target, recurring UX patterns found
type: project
---

**Project:** 알뷰어 (rhwp-viewer) — Mobile-first PWA for viewing HWP/HWPX documents client-side via WASM.

**Why:** Korean document format (HWP) has no good mobile viewer. All rendering is client-side via @rhwp/core WASM.

**Tech Stack:** Vite + TypeScript (vanilla, no UI framework), custom CSS variables, no component library.

**Accessibility Target:** WCAG 2.1 AA (inferred from color palette and structure — not explicitly stated by user).

**Design System:** Custom CSS variables (--color-primary, --color-surface, etc.), no external library. Light/dark via prefers-color-scheme.

**Brand Colors:**
- Light: Primary #1a73e8, BG #ffffff, Text #1a1a1a
- Dark: Primary #4a9eff, BG #1a1a2e, Text #e8eaed

**Typography:** system-ui / -apple-system stack, no custom font loaded.

**Known UX Anti-Patterns Found (April 2026 audit):**
1. Immersive auto-hide fires after 3 s even on first view — user hasn't oriented yet
2. `prompt()` used for page jump input — blocks main thread, no mobile keyboard control
3. `window.confirm()` for SW update notification — disruptive native dialog
4. PWA install dismiss button (32×32 px) below 44×44 px WCAG touch target minimum
5. Install dismiss button uses ✕ text glyph, not an SVG — inconsistent with rest of UI
6. Loading progress bar width 160 px — too narrow on mobile, hard to read progress
7. Error screen missing a "홈으로 돌아가기" secondary action when retry is hidden
8. `page-info` click → `prompt()` for page jump — not accessible, blocks thread
9. Toolbar safe-area-inset-top not applied — content clips under status bar on iOS notch
10. Nav bar safe-area-inset-bottom not applied — overlaps iPhone home indicator
11. SW update uses `window.confirm()` — should be non-blocking toast with action button
12. `--color-text-secondary` (#5f6368 on #ffffff) contrast ratio ≈ 5.9:1 — passes AA normal but borderline
13. `--color-text-hint` (#9aa0a6 on #ffffff) contrast ratio ≈ 2.85:1 — FAILS WCAG 1.4.3 AA
14. Loading card min-width not set — collapses on narrow phones
15. `.recent-item` touch target height 11px padding each side — total ~44 px but tight; gap 3 px between items reduces perceived target

**How to apply:** Reference these patterns when reviewing new screens or making recommendations to avoid re-introducing them.
