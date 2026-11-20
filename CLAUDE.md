# Canvas Study MCP

A local MCP server that connects a student's AI assistant to their own Canvas courses in ways that support learning. Students install it themselves with their own Canvas access token.

## Design Rules

These are the point of the project. Do not weaken them without the maintainer's say-so.

- **Read-only toward Canvas.** `CanvasClient` (`src/canvas.ts`) issues only GET requests. Never add a tool or client method that submits work, takes a quiz, posts, uploads, or otherwise changes Canvas. A test asserts the client's method list.
- **Local only.** There is no hosted service and never a server that handles students' tokens. The token is read from the environment and sent only to the configured Canvas origin, over https; pagination links to any other host are refused.
- **Tools are shaped around learning, not API endpoints.** Before adding a tool, ask what study practice it supports (retrieval practice, spaced review, planning from deadlines, using feedback). Do not grow this into a general Canvas API wrapper.
- **Answers come after attempts.** Review prompts are returned without answers; the reference answer comes back only from `attempt_review`, and `rate_review` fails without a recorded attempt. Keep answers out of any tool output a student sees before attempting.
- **The server cannot enforce what the assistant does.** Tool descriptions and `src/instructions.ts` steer the assistant; treat their wording as part of the product and keep them plain, specific, and honest about that limit.
- **Written for non-specialists.** Students who install this may never have used a terminal. Error messages say what to do next, and the README install path must work without one.

## Layout

- `src/index.ts`: entry point; reads config and starts the stdio server.
- `src/server.ts`: all tool definitions.
- `src/canvas.ts`: read-only Canvas REST client with pagination.
- `src/store.ts`: spaced-review state in one JSON file (`~/.canvas-study-mcp/reviews.json`), scheduled with FSRS via `ts-fsrs`.
- `src/instructions.ts`: the server instructions sent to the assistant.
- `manifest.json` and `scripts/pack-mcpb.mjs`: the Claude Desktop bundle (`.mcpb`).
- `scripts/seed-local-canvas.mjs`: seeds a local development Canvas. It is the only code that writes to Canvas and refuses non-`.localhost` addresses.
- `scripts/vm/`: a real install in Claude Desktop inside a Parallels VM (see its README).

Never commit machine-specific paths, hostnames, or passwords, even throwaway ones: they go in `.env.local`.

## Commands

```sh
npm run check      # typecheck, tests, build; run before calling work done
npm run pack:mcpb  # build canvas-study.mcpb
```

The build bundles everything into `dist/index.js` with esbuild, so the `.mcpb` needs no `node_modules`.

## Versioning

Date-based, `YYYY.M.MINOR`. `package.json` is the source of truth; `manifest.json` carries the same version and the pack script overwrites it from `package.json`.

## Testing Against a Real Canvas

The maintainer runs a local Canvas in Docker from another project. Its directory and address are `CANVAS_DIR` and `CANVAS_URL` in `.env.local` (gitignored; see `.env.local.example`); read that directory's README. It serves a `.localhost` address with an mkcert certificate.

- That instance is the other project's test fixture. Ask before starting it or adding data, use the separate `CSM101` course, and never run its `down.sh --volumes`.
- Start with its `up.sh`, make sure base users exist with its `seed.sh --json`, then run this repo's seeder with `.env.local` loaded and `CANVAS_ADMIN_TOKEN` taken from its `env.sh`, writing the output to `.env` (gitignored).
- Node needs `NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem"` to trust the certificate. That path contains spaces, so quote it.
- Mocked tests cannot catch Canvas response-shape surprises, so exercise any new or changed Canvas tool against this instance.
