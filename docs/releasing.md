# Releasing `@vieko/anvil`

The CLI (`packages/cli`, published as **`@vieko/anvil`**) is the **only**
published artifact. `@anvil/core` is **bundled into it** at build time (esbuild
inlines the engine; `@earendil-works/*` and `typebox` stay external, declared as
runtime `dependencies`) and is itself `private` — it is never published.

## Steps

1. **Bump the version** (the published one is `@vieko/anvil`'s):

   ```bash
   npm version <patch|minor|major> --workspace @vieko/anvil
   ```

   Keep the root and `@anvil/core` versions in step if you track them.

2. **Gate** — must be green:

   ```bash
   npm run check        # biome -> tsc --noEmit -> build -> test
   ```

3. **Prove the bundle is standalone** (catches a missing external the gate
   can't): the build is self-cleaning, so `dist/` holds only `bin.js` (+ map).

   ```bash
   cd packages/cli && npm pack            # inspect the tarball
   # in a scratch dir: npm install ./vieko-anvil-*.tgz && npx anvil --version
   ```

   The installed tree must contain `@earendil-works/*` + `typebox` and **no**
   `@anvil/*` (core is inlined).

4. **Publish** (scoped public; `prepublishOnly` re-cleans + rebuilds):

   ```bash
   npm publish --workspace @vieko/anvil
   ```

## Guard

`npm publish` is a **confirmed-only** operation: never run it without an explicit
instruction in the active turn (see the root `AGENTS.md` destructive-command
guard). Generating and inspecting a tarball (`npm pack`) is always safe.
