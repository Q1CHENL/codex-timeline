# Codex Timeline

**View it:** [Codex Timeline](https://codex-timeline.loftycrown20.chatgpt.site)

An interactive timeline of the Codex desktop app's home screen, from the first public release in February 2026 to October 2026. Every version is rendered by its own original frontend, and the timeline animates between them. Scrub, scroll or play through every public release and dated model change in light and dark themes, and save any moment as a PNG. Stop on a version and its home screen responds like the app: controls show their hover states and tooltips, clicks open the app's menus and dialogs or toggle its sidebar and panels, and the composer takes typing.

The site is a single offline HTML file; once loaded it needs no server or network.

> An unofficial fan project, not affiliated with or endorsed by OpenAI. Codex and OpenAI are trademarks of OpenAI.

## How it works

1. **Find versions.** Public version numbers come from Homebrew's [`codex-app`](https://github.com/Homebrew/homebrew-cask/commits/main/Casks/c/codex-app.rb) and [`chatgpt`](https://github.com/Homebrew/homebrew-cask/commits/main/Casks/c/chatgpt.rb) cask histories and the official [update feed](https://persistent.oaistatic.com/codex-app-prod/appcast.xml); `discover-versions.py` adds new ones to `data/catalog.json`.
2. **Extract each frontend.** `fetch-versions.py` reads only `app.asar` out of each official package with HTTP range requests and checks member sizes, CRC32 and the bundle identifier. Nothing is installed or executed natively.
3. **Render in isolation.** `server.py` serves each unmodified frontend to Chrome with a fake host (`bridge.js`, plus a per-version adapter from `generate-adapters.py`): a 1200 × 780 window, empty sample account, no network. The selected model and reasoning level follow the dated rollout policy in `data/model-rollout-policy.json`; the model picker offers that period's public catalog, each model with its own reasoning levels.
4. **Capture.** `capture-all.cjs` runs `capture-scene.js` in each rendered frontend to record every visible element's text, SVG, images, geometry, clipping and computed styles, and saves a native screenshot.
5. **Record interactions.** For each distinct screen, `capture-states.cjs` hovers and clicks every control and types into the composer in the native frontend, recording what changes: tooltips, menus and their submenus, dialogs, and the layout each toggle leads to (sidebar, panels, collapsible sections), which it records the same way. Toggles do not combine.
6. **Assemble.** `prepare-scenes.py` matches elements across versions, deduplicates identical screens and turns recorded interactions into per-screen states; `build-page.py` packs everything into one page. The player (`player/`) interpolates position, size and style between matched elements.
7. **Verify.** `verify.cjs` loads the page offline, selects every timeline node, and compares every distinct screen and its PNG export pixel by pixel with the native screenshot.

Dates are package archive times, not announced release or rollout dates. The sample account has no history, saved settings or server-side feature flags, so a real account may have looked different. The app's own fonts are not embedded; text uses system fonts.

## Rebuilding

You only need this to reproduce the site yourself or to add new versions. The extracted frontends, captures and built page contain the app's interface, so they are generated locally rather than committed.

Requires Python 3, Node and Google Chrome (tested with Python 3.13 and Node 24), plus about 50 GB of disk.

```bash
npm install
npm run rebuild
```

`rebuild` picks up newly published versions, fetches and checks each frontend, captures both themes, assembles and verifies the page, and writes `dist/codex-timeline.html`. Steps that are already current are skipped: with frontends and captures in place a rerun takes about a quarter of an hour, mostly scene assembly, while the first run also downloads every frontend, captures every version and records every screen's interactions, which takes several hours. While working on the player itself, `npm run page` rebuilds the page from existing captures in under a second.

Keep in mind:

- Packages are downloaded from OpenAI's servers; a version that is taken down can no longer be rebuilt. One ARM package already returns 404, so its Intel build is used.
- `data/catalog.json` records every version found so far. A rebuild adds versions published since; anything that has dropped out of both the update feed and Homebrew before being recorded cannot be found.
- Builds are byte-for-byte reproducible from the same captures. On another machine, Chrome, system fonts or the OS may shift a few pixels; the pixel comparison allows for that.
- Changing `capture-scene.js`, `bridge.js` or `server.py` makes every capture stale, and a changed model fixture or renderer adapter makes that version's captures stale; the next rebuild retakes them. Adding versions leaves existing captures alone.

## Layout

| Path | Contents |
|---|---|
| `pipeline/` | Extraction, isolated host, capture, scene assembly, publishing and `rebuild.py` |
| `player/` | The player page and its build script |
| `verify/` | Pixel comparison of the page and its export with the native screenshots |
| `data/` | Version catalog, model rollout research and policy. Downloaded frontends, captures and intermediate files also land here and are ignored |
| `dist/` | The built page (ignored) |

## License

[MIT](LICENSE) for the code in this repository. It does not cover the Codex app or its interface, icons and other assets, which belong to OpenAI.
