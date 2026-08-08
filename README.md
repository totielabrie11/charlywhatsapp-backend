# CharlyWhatsapp — Backend

Node.js + Express 5 + Socket.IO + Drizzle/Postgres + Baileys (WhatsApp).
Fully standalone: no reference to the original pnpm workspace.

## Setup

```bash
pnpm install
cp .env.example .env   # fill in DATABASE_URL, Clerk keys, Google OAuth, etc.
pnpm dev
```

`pnpm dev` builds (esbuild bundle) and then runs the server — this matches
the original project's `dev` script exactly (there is no separate
watch-mode dev script upstream, so none was invented here).

## Build / run in production

```bash
pnpm build     # bundles to dist/index.mjs via esbuild (build.mjs)
pnpm start     # node dist/index.mjs
```

## Structure

```
src/                  Application source (routes, services, middlewares — unchanged from the original)
packages/db/          Vendored copy of the Drizzle schema + db client (was @workspace/db in the monorepo)
packages/api-zod/     Vendored copy of the generated Zod validators (was @workspace/api-zod)
scripts/              pdf_to_images.py (copied into dist/scripts at build time) and the
                       backfillWorkspaces.ts maintenance script (run manually with `pnpm dlx tsx scripts/backfillWorkspaces.ts` if needed)
build.mjs             esbuild bundling config — copied unmodified, all paths were already
                       self-relative to this folder
```

## Notes on what changed vs. the monorepo version

- `@workspace/db` and `@workspace/api-zod` are vendored as local `file:`
  dependencies under `packages/` instead of being sibling workspace
  packages. Import paths in `src/**` are unchanged (`from "@workspace/db"`
  etc. still work, resolved via the `file:` dependency + a `paths` mapping
  in `tsconfig.json` for typechecking).
- `WA_AUTH_DIR` default changed from `../../.wa_auth` (a path that only
  made sense inside the old monorepo, two levels above this artifact) to
  `./.wa_auth` (a folder inside this project). Only the **default**
  changed — setting `WA_AUTH_DIR` explicitly in `.env` always overrides it,
  same as before.
- Fixed two latent, pre-existing TypeScript errors uncovered while
  typechecking standalone (see "Problems found" in the migration report) —
  no runtime behavior changed.

## System requirements (outside package.json)

- **ffmpeg** — used to transcode WhatsApp voice notes (`src/services/whatsapp.ts`)
- **python3** with **PyMuPDF** installed (`pip install pymupdf`) — used by
  `scripts/pdf_to_images.py` for PDF text/image extraction
- **PostgreSQL** — connect via `DATABASE_URL`

## Tested

- `pnpm install` — succeeds
- `pnpm run typecheck` — passes with 0 errors
- `pnpm run build` — succeeds (esbuild bundle, ~15MB dist/index.mjs, plus pino worker files)
- Booting `node dist/index.mjs` was smoke-tested: it loads all routes/services
  correctly and fails only at the expected point — connecting to
  `DATABASE_URL` — since no Postgres instance was available in this
  environment. Point `DATABASE_URL` at a real Postgres database to complete
  the boot sequence.
