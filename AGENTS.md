# Repository Guidelines

## Package releases

- Packages are published by [`.github/workflows/publish.yml`](.github/workflows/publish.yml) after a push to `main`.
- The workflow uses npm Trusted Publishing through GitHub Actions OIDC. Do **not** run `npm publish` locally and no local `npm login`/`NPM_TOKEN` is required for normal releases.
- To release a changed package, bump its `package.json` version and matching `package-lock.json` version, run its checks, commit the release bump, and push `main`.
- The workflow checks npm first and publishes only versions that do not already exist. A feature-only commit with an unchanged version triggers the workflow but is skipped.
- Check release status with:

  ```bash
  gh run list --repo cyzlmh/pi-extensions --workflow publish.yml --limit 3
  ```
