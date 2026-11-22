# Code signing and releases (Windows)

Unsigned installers trigger SmartScreen warnings, and electron-updater only installs an update
whose Authenticode publisher matches the running app (`verifyUpdateCodeSignature: true`).

## Recommended: Azure Trusted Signing

Cheapest path that works in CI (no USB hardware token), roughly USD 10 / month.

1. Azure portal → create a **Trusted Signing account** (region close to you).
2. Complete **identity validation** (individual or organisation). This can take a few days.
3. Create a **certificate profile** (Public Trust).
4. Create an **app registration** (service principal) and give it the role
   _Trusted Signing Certificate Profile Signer_ on the account.
5. In GitHub → repo → Settings → Environments → **production** (add yourself as required
   reviewer), add:
   - secrets: `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `RELEASES_TOKEN`
   - variables: `WIN_PUBLISHER_NAME` (exactly the CN on the certificate),
     `AZURE_SIGNING_ENDPOINT` (e.g. `https://weu.codesigning.azure.net`),
     `AZURE_CERT_PROFILE`, `AZURE_SIGNING_ACCOUNT`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`

Alternative: an OV/EV certificate from a CA. Since 2023 these keys must live on hardware (HSM /
token), which does not work in hosted CI without a cloud HSM. Prefer Trusted Signing.

## Releases repository

Auto-update reads GitHub Releases. The source repo is private, and electron-updater would need a
token to read a private repo's releases, which would mean shipping a secret inside the app. So
releases are published to a separate **public, binaries-only** repo:

1. Create `<owner>/desk-buddy-releases` (public, empty, add a README).
2. Create a fine-grained PAT: _Only select repositories_ → `desk-buddy-releases`,
   permission **Contents: Read and write**, expiry ≤ 90 days. Save it as `RELEASES_TOKEN`.

## Cutting a release

```bash
npm version 0.2.0 -w @desk-buddy/desktop --no-git-tag-version
```

```bash
git commit -am "release: v0.2.0" && git push
```

After CI is green on `main`:

```bash
git tag v0.2.0 && git push origin v0.2.0
```

The Release workflow checks the tag is on `main` and matches the package version, then runs lint,
types, tests and audit, builds, signs with Azure Trusted Signing, verifies the Authenticode
signature and publishes the installer and `latest.yml` to `desk-buddy-releases`. Installed apps
check for updates at start-up and every 6 hours, download in the background and install on quit
(or via tray → Restart to update).
