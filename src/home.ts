// The page served at /.

import { gray, grayDark } from "@radix-ui/colors";
import { CLAUDE, CLICKHOUSE, CLOUDFLARE, INTERFACE, OPENAI, TINYBIRD } from "./logos";

const REPO_URL = "https://github.com/dqnamo/seerstack";

// Radix Colors' gray scale as --gray-1 … --gray-12, following the visitor's light or dark preference.
const GRAY_VARS = Array.from({ length: 12 }, (_, i) => {
  const step = `gray${i + 1}` as keyof typeof gray;
  return `--gray-${i + 1}: light-dark(${gray[step]}, ${grayDark[step]});`;
}).join(" ");

const appIcon = (name: string, label: string, svg: string) =>
  `<span class="icon ${name}" role="img" aria-label="${label}" title="${label}">${svg}</span>`;

export const HOME_HTML = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Seerstack</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@100..900&display=swap">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Pirata+One&text=dqnamo&display=swap">
<style>
  :root { color-scheme: light dark; ${GRAY_VARS} background: var(--gray-1); color: var(--gray-12); font: 16px/1.5 "Inter", system-ui, sans-serif; }
  body { margin: 0; padding: 0 1.5rem; min-height: 100dvh; display: flex; flex-direction: column; justify-content: center; }
  .container { width: 100%; max-width: 56rem; margin: 0 auto; padding: 5rem 0; }
  .logo { margin: 0; font-size: 1.0625rem; font-weight: 500; }
  .tagline { margin: 0.25rem 0 0; font-size: 0.9375rem; color: var(--gray-11); }
  .actions { display: flex; flex-wrap: wrap; gap: 0.75rem; margin: 1.5rem 0 0; }
  /* Buttons are lit from the top like the icons: a light inner edge and glow, darker towards the bottom. */
  .button { box-sizing: border-box; display: inline-flex; align-items: center; gap: 0.5rem; height: 2.25rem; padding: 0 0.875rem; border: 1px solid var(--gray-7); border-radius: 0.625rem; background: var(--gray-1); box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.12), 0 1px 2px rgb(0 0 0 / 0.06); color: inherit; font-size: 0.875rem; font-weight: 500; text-decoration: none; }
  .button:hover { border-color: var(--gray-8); }
  .button.deploy { --bg: #f38020; border-color: color-mix(in srgb, var(--bg) 75%, #000); background: linear-gradient(color-mix(in srgb, var(--bg) 80%, #fff), var(--bg)); box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.35), inset 0 6px 10px -6px rgb(255 255 255 / 0.4), 0 1px 2px rgb(0 0 0 / 0.12), 0 2px 8px color-mix(in srgb, var(--bg) 30%, transparent); color: #fff; text-shadow: 0 1px 0 rgb(0 0 0 / 0.12); }
  .button.deploy:hover { --bg: #e06d10; }
  .features { list-style: none; margin: 2.5rem 0 0; padding: 0; display: grid; grid-template-columns: repeat(3, 1fr); gap: 1.5rem; }
  .features .image { position: relative; aspect-ratio: 1; }
  /* Grid lines behind the icons, fading out towards the edges. */
  .features .image::before { content: ""; position: absolute; inset: 0; background-image: linear-gradient(to right, var(--line) 1px, transparent 1px), linear-gradient(to bottom, var(--line) 1px, transparent 1px); background-size: 1.5rem 1.5rem; background-position: center; mask-image: radial-gradient(closest-side, #000 50%, transparent); --line: var(--gray-6); }
  .features .icons { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; gap: 0.625rem; }
  /* Each icon is lit from the top: a radial gradient and a border derived from its brand colour. */
  .icon { --border: color-mix(in srgb, var(--bg) 70%, #000); box-sizing: border-box; display: grid; place-items: center; width: 3.25rem; height: 3.25rem; border: 1px solid var(--border); border-radius: 0.875rem; background: radial-gradient(circle at 50% 0%, color-mix(in srgb, var(--bg) 60%, #fff), var(--bg) 60%, color-mix(in srgb, var(--bg) 85%, #000)); box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.3), 0 1px 2px rgb(0 0 0 / 0.2), 0 8px 20px -4px rgb(0 0 0 / 0.3), 0 4px 12px color-mix(in srgb, var(--bg) 35%, transparent); }
  .icon svg { width: 1.75rem; height: 1.75rem; fill: currentColor; }
  .icon.clickhouse { --bg: #faff69; color: #000; }
  .icon.tinybird { --bg: #27f795; color: #000; }
  .icon.openai { --bg: #000; --border: #3a3a3a; color: #fff; }
  .icon.cloudflare { --bg: #f38020; color: #fff; }
  .icon.claude { --bg: #d97757; color: #fff; }
  .features h2 { margin: 1rem 0 0; font-size: 0.9375rem; font-weight: 500; }
  .features p { margin: 0.25rem 0 0; font-size: 0.875rem; color: var(--gray-11); }
  .credit { display: flex; flex-wrap: wrap; align-items: center; gap: 0.75rem; margin: 6rem 0 0; font-size: 0.8125rem; }
  .credit .muted { color: var(--gray-11); }
  .credit a { display: inline-flex; align-items: center; color: inherit; text-decoration: none; }
  .credit a:hover { opacity: 0.7; }
  /* Each studio's own lockup: dqnamo's Pirata One wordmark, Interface's mark beside its name. */
  .credit .dqnamo { font-family: "Pirata One", serif; font-size: 1.625rem; font-weight: 700; line-height: 1; }
  .credit .interface { gap: 0.5rem; }
  .credit .interface .mark { display: flex; }
  .credit .interface svg { width: 1.75rem; height: 1.75rem; fill: currentColor; }
  .credit .interface .name { font-weight: 500; line-height: 1.05; letter-spacing: -0.01em; }
  /* Phones: one column, wide image areas instead of tall squares, and a little
     less side padding so the buttons and credit fit on one line at 320px. */
  @media (max-width: 40rem) {
    body { padding: 0 1.25rem; }
    .features { grid-template-columns: 1fr; gap: 2rem; }
    .features .image { aspect-ratio: 16 / 9; }
    .credit { gap: 0.5rem; }
    .credit .dqnamo { font-size: 1.5rem; }
    .credit .interface svg { width: 1.5rem; height: 1.5rem; }
  }
</style>
<div class="container">
  <header>
    <h1 class="logo">seerstack</h1>
    <p class="tagline">Simple, open source analytics with no dashboard. You just ask your agent.</p>
    <div class="actions">
      <a class="button" href="${REPO_URL}">
        <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"/></svg>
        GitHub
      </a>
      <a class="button deploy" href="https://deploy.workers.cloudflare.com/?url=${REPO_URL}">Deploy to Cloudflare</a>
    </div>
  </header>
  <ul class="features">
    <li>
      <div class="image"><div class="icons">${appIcon("clickhouse", "ClickHouse", CLICKHOUSE)}${appIcon("tinybird", "Tinybird", TINYBIRD)}</div></div>
      <h2>One table for all your sites</h2>
      <p>Pageviews and events from every site go into a single ClickHouse table, hosted on Tinybird.</p>
    </li>
    <li>
      <div class="image"><div class="icons">${appIcon("cloudflare", "Cloudflare", CLOUDFLARE)}</div></div>
      <h2>A tiny API on Cloudflare</h2>
      <p>Add a script tag and pageviews start coming in. No cookies. Your servers can send events too.</p>
    </li>
    <li>
      <div class="image"><div class="icons">${appIcon("claude", "Claude", CLAUDE)}${appIcon("openai", "OpenAI", OPENAI)}</div></div>
      <h2>Your agent is the dashboard</h2>
      <p>Connect Claude, ChatGPT, or any agent with MCP. Ask how your sites are doing and it'll go look.</p>
    </li>
  </ul>
  <footer class="credit">
    <a class="dqnamo" href="https://dqnamo.com">dqnamo</a>
    <span class="muted" aria-hidden="true">×</span>
    <a class="interface" href="https://interface.london"><span class="mark" aria-hidden="true">${INTERFACE}</span><span class="name">The Interface Company<br>of London.</span></a>
  </footer>
</div>
`;
