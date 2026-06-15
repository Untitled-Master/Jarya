<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->

## Project identity

**gpx.run** — GPX route viewer, simulation playback, and TikTok-style vertical video export. Scaffolded from `create-rvst` (React + Vite + shadcn + Tailwind).

- `src/components/GpxViewer.jsx` is a ~1800-line monolithic component containing the entire app (GPX parse, Leaflet map, 3D Canvas chase-cam, simulation engine, video recorder). Keep logic contained there unless refactoring — there is no router or page structure.
- Frontend: React 19, JSX (not TSX), Vite 6, Tailwind 3, shadcn/ui New York style.
- Maps: Leaflet + react-leaflet. Icons: lucide-react.
- Backend: Convex (TypeScript). Schema defines `users` and `gpxFiles` tables.

## Key commands

| Command | Action |
|---|---|
| `npm run dev` | Vite dev server (port 5173) |
| `npm run build` | Vite production build |
| `npm run lint` | ESLint (all JS/JSX files) |
| `npm run preview` | Vite preview server |
| `npx convex dev` | Convex dev server (requires `.env.local`) |

## Path alias

`@/` → `src/` (configured in `vite.config.js` + `jsconfig.json`).

## Architecture & conventions

- Entry: `src/main.jsx` → `src/App.jsx` → `src/components/GpxViewer.jsx`.
- `src/lib/utils.js` exports `cn()` (clsx + tailwind-merge).
- shadcn/ui primitives live in `src/components/ui/`.
- Frontend is JSX, backend (`convex/`) is TypeScript.
- GPX data persists to **localStorage** (`gpx_last_route`, `gpx_view_mode`). The Convex backend is not yet wired into the frontend.
- Vercel deploys with SPA fallback routing (`vercel.json`).
