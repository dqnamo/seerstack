// The look shared by every page: Inter on Radix grays, the wordmark and the buttons.

import { amber, amberDark, gray, grayDark } from "@radix-ui/colors";

// Radix Colors scales as --gray-1 … --gray-12 (and amber), following the visitor's light or dark preference.
const scaleVars = (name: string, light: Record<string, string>, dark: Record<string, string>) =>
  Array.from(
    { length: 12 },
    (_, i) => `--${name}-${i + 1}: light-dark(${light[`${name}${i + 1}`]}, ${dark[`${name}${i + 1}`]});`,
  ).join(" ");

export const HEAD = `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@100..900&display=swap">`;

export const BASE_CSS = `
  :root { color-scheme: light dark; ${scaleVars("gray", gray, grayDark)} ${scaleVars("amber", amber, amberDark)} background: var(--gray-1); color: var(--gray-12); font: 16px/1.5 "Inter", system-ui, sans-serif; }
  @property --bg { syntax: "<color>"; inherits: true; initial-value: transparent; }
  body { margin: 0; padding: 0 1.5rem; min-height: 100dvh; }
  .logo { margin: 0; font-size: 1.0625rem; font-weight: 500; }
  .actions { display: flex; flex-wrap: wrap; gap: 0.75rem; margin: 1.5rem 0 0; }
  /* Buttons are lit from the top like the icons: a light inner edge and glow, darker towards the bottom. */
  .button { box-sizing: border-box; display: inline-flex; align-items: center; gap: 0.5rem; height: 2.25rem; padding: 0 0.875rem; border: 1px solid var(--gray-7); border-radius: 0.625rem; background: var(--gray-1); box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.12), 0 1px 2px rgb(0 0 0 / 0.06); color: inherit; font-family: inherit; font-size: 0.875rem; font-weight: 500; text-decoration: none; cursor: pointer; transition: border-color 200ms ease; }
  .button:hover { border-color: var(--gray-8); }
  /* A solid button takes its colour from --bg. */
  .button.solid { border-color: color-mix(in srgb, var(--bg) 75%, #000); background: linear-gradient(color-mix(in srgb, var(--bg) 80%, #fff), var(--bg)); box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.35), inset 0 6px 10px -6px rgb(255 255 255 / 0.4), 0 1px 2px rgb(0 0 0 / 0.12), 0 2px 8px color-mix(in srgb, var(--bg) 30%, transparent); color: #fff; text-shadow: 0 1px 0 rgb(0 0 0 / 0.12); transition: --bg 200ms ease; }
  @media (max-width: 40rem) {
    body { padding: 0 1.25rem; }
  }
`;
