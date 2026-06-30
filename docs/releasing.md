# Releasing `@vieko/anvil`

The CLI (`packages/cli`, published as **`@vieko/anvil`**) is the **only**
published artifact. `@anvil/core` is **bundled into it** at build time (esbuild
inlines the engine; `@earendil-works/*` and `typebox` stay external, declared as
runtime `dependencies`) and is itself `private` — it is never published.

Releases are **tag-driven and automated**: pushing a `vX.Y.Z` tag triggers
[`.github/workflows/release.yml`](../.github/workflows/release.yml), which runs
the gate, publishes to npm via **OIDC trusted publishing** (no token, no OTP,
with provenance), and cuts the GitHub release.

## One-time setup (npmjs.com)

Configure the trusted publisher once, on the package:

- npmjs.com → **@vieko/anvil** → Settings → **Trusted Publisher** → GitHub Actions
- Organization or user: `vieko` · Repository: `anvil` · Workflow filename:
  `release.yml` · Environment: *(leave blank)*

This is what lets the workflow publish without a stored token or a 2FA prompt.

## Cut a release

1. **Bump the version** (the published one is `@vieko/anvil`'s; keep root and
   `@anvil/core` in step), commit, and push `main`:

   ```bash
   npm version <patch|minor|major> --workspace @vieko/anvil --no-git-tag-version
   # also bump root + packages/core to match, then commit + push
   npm run check        # be green locally first
   ```

2. **Tag the release commit and push the tag** — that is the whole trigger:

   ```bash
   git tag -a vX.Y.Z -m vX.Y.Z && git push origin vX.Y.Z
   ```

   The tag version must equal `packages/cli/package.json` (the workflow enforces
   this). Watch it land: `gh run watch`.

The workflow does the rest: gate → `npm publish` (OIDC) → GitHub release with
generated notes.

## Manual fallback

If trusted publishing is unavailable (OIDC misconfigured, registry down):

```bash
npm publish --workspace @vieko/anvil --otp=<code>   # 2FA prompts for the OTP
git tag -a vX.Y.Z <commit> -m vX.Y.Z && git push origin vX.Y.Z
gh release create vX.Y.Z --verify-tag --title vX.Y.Z --generate-notes --latest
```

## Guard

A hand-run `npm publish` is a **confirmed-only** operation: never run it without
an explicit instruction in the active turn (see the root `AGENTS.md`
destructive-command guard). The automated workflow is exempt — it only fires on
a tag you pushed. Generating and inspecting a tarball (`npm pack`) is always safe.
