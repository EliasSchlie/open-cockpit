# App Releases

Only needed for Electron-side changes (UI, main process, daemon). Hook/skill changes don't need a new binary — they auto-deploy via the plugin pipeline.

## Steps

1. Bump version: `npm version X.Y.Z --no-git-tag-version`
2. Commit: `git add package.json package-lock.json && git commit -m "chore: bump version to X.Y.Z"`
3. Push to main: `git pull && git push`
4. Tag and push: `git tag vX.Y.Z && git push origin vX.Y.Z`
5. Wait for CI: `.github/workflows/build-release.yml` builds all 3 platforms (~5 min)
6. Publish the draft: `gh release edit vX.Y.Z --draft=false --latest`

electron-builder creates a **draft** release. You must publish it manually (step 6) — this is intentional as a review gate.

## What CI does

Builds DMG+ZIP (macOS, code signed + Apple notarized), AppImage+deb (Linux), exe (Windows). Uploads binaries + `latest-*.yml` files (required for in-app auto-updater).

## Secrets required

| Secret | Description |
|--------|-------------|
| `MAC_CERTIFICATE` | base64-encoded .p12 (Developer ID Application certificate) |
| `MAC_CERTIFICATE_PASSWORD` | .p12 export password |
| `APPLE_ID` | Apple Developer account email |
| `APPLE_APP_SPECIFIC_PASSWORD` | From [account.apple.com](https://account.apple.com) → App-Specific Passwords |

Team ID `Q2U8K9N3BL` is hardcoded in the workflow.

## If a build fails

Fix the issue, then re-tag:

```bash
git tag -d vX.Y.Z && git push origin :refs/tags/vX.Y.Z
gh release delete vX.Y.Z --yes 2>/dev/null
git tag vX.Y.Z && git push origin vX.Y.Z
```

## Code signing setup (one-time)

The Developer ID Application certificate is from the Apple Developer Program ($99/year). To set up signing on a new machine:

1. Export the certificate from Keychain Access as `.p12`
2. Base64-encode: `base64 -i cert.p12 | tr -d '\n' > cert-b64.txt`
3. Set GitHub secret: `gh secret set MAC_CERTIFICATE < cert-b64.txt`
4. Set password: `gh secret set MAC_CERTIFICATE_PASSWORD`
5. Set Apple ID: `gh secret set APPLE_ID`
6. Generate app-specific password at account.apple.com and set: `gh secret set APPLE_APP_SPECIFIC_PASSWORD`
