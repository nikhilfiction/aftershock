# Aftershock UI

React + TypeScript (Vite), TanStack Query for server state, React Flow + dagre for the graph.

```bash
npm install
npm run build            # into ../aftershock/web; `aftershock serve` then shows it at http://localhost:8000
npm run dev              # for working on the UI: http://localhost:5173, with /api forwarded to port 8000
```

The app calls the API at `/api` on its own address, so it needs no settings. Start `aftershock serve` before
`npm run dev`. If the API runs somewhere else, set `AFTERSHOCK_API` (see `.env.example`).

| Script | |
| --- | --- |
| `npm test` | 48 tests (Vitest + Testing Library, API faked with MSW) |
| `npm run typecheck` | TypeScript |
| `npm run lint` | oxlint |
| `npm run build` | production build into `../aftershock/web`, served by `aftershock serve` |
| `npm run gen:api` | regenerate `src/api/schema.d.ts` from the running API's OpenAPI schema |

```
src/
  api/          client.ts (the only code that calls fetch), hooks.ts (queries and mutations), generated types
  components/   the page frame (Shell), icons, symbol search, small UI pieces
    report/     the report page: analyze bar, tiles, radar, panels, inspector, call graph
  lib/          plain functions, tested on their own: radar layout, diff reading, report numbers
  pages/        repositories, one repository, one scan
  styles/       tokens.css (every colour and size), app.css, report.css
  test/         tests, fixtures and the fake API
```

The look: one dark palette, IBM Plex Sans for words and JetBrains Mono for code and labels (both bundled
through @fontsource, so nothing loads from Google). Each colour means one thing everywhere; the list is at
the top of `src/styles/tokens.css`. Below 720px wide the report turns into a single column with tabs at the
bottom.
