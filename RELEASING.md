# Releasing

Releases are published to npm by `.github/workflows/publish.yml` (with provenance) when `main` receives a commit that
bumps the version, or manually via **Actions > Publish to npm > Run workflow**.

## Steps

1. Bump the version in **both** `package.json` and `server.json` (and the lockfile: `npm install --package-lock-only`).
2. Run `npm run build && npm test`.
3. Merge to `main`. The workflow installs, tests, builds and runs `npm publish --provenance --access public`,
   then pushes a `vX.Y.Z` tag.
4. **Approve the staged release.** This package uses npm staged publishing: a successful CI publish places the version
   in a holding area, and it is not public until a maintainer approves it with 2FA. On npmjs.com open the package,
   go to **Staged Packages**, review the version and click **Approve**.
5. Check it is live: `npm view jira-mcp-server-pro versions`.
6. Optional: list it in the MCP Registry: `mcp-publisher login github && mcp-publisher publish`.

If a run fails with `E409 ... previously staged version`, the version is already staged; approve it instead of re-running.

## The npm token

CI authenticates with the `NPM_TOKEN` repository secret.

- Create a **granular access token** limited to this package (read and write) with an expiry.
- Store it only as a secret, without writing it to a file or pasting it anywhere:

  ```bash
  gh secret set NPM_TOKEN --repo yogeshhrathod/JiraMCP
  ```

  The command prompts for the value. Never commit it, put it in a workflow file or share it in chat or issues.
- If a token is ever exposed, revoke it on npmjs.com immediately and set a new one.
- Alternative without a stored token: configure **Trusted Publisher** for this package on npmjs.com
  (owner `yogeshhrathod`, repository `JiraMCP`, workflow `publish.yml`) and remove the `NODE_AUTH_TOKEN` line from the
  workflow. This needs npm 11.5.1 or newer, which Node 24 provides.

## Networks that intercept npm

Some corporate gateways intercept authenticated requests to `registry.npmjs.org`, which shows up as `401` on
`npm whoami` or `404` on `npm publish` even with a valid token. Publish from CI, or from another network.
