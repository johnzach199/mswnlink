# Make the macOS DMG open without Gatekeeper's “damaged” warning

A code change alone cannot make Gatekeeper trust an unsigned macOS app. Direct distribution requires a **Developer ID Application** certificate and Apple notarization credentials. This project now refuses to publish an unsigned or unnotarized macOS build and verifies the resulting app after packaging.

## Required Apple account

You need an active Apple Developer Program membership and a **Developer ID Application** certificate. Do not use an Apple Distribution / Mac App Store certificate for the downloadable DMG.

## GitHub Actions secrets

In GitHub, open **Settings → Secrets and variables → Actions → New repository secret** and add:

- `MAC_CSC_LINK`: the one-line base64 encoding of your exported Developer ID Application `.p12` certificate.
- `MAC_CSC_KEY_PASSWORD`: the password used when exporting that `.p12` file.
- `APPLE_API_KEY`: the one-line base64 encoding of the App Store Connect `.p8` API key's file contents.
- `APPLE_API_KEY_ID`: the key ID shown in App Store Connect.
- `APPLE_API_ISSUER`: the Issuer ID shown in App Store Connect.

Example encoding commands run locally (do not commit the resulting values to Git):

Linux:

```bash
base64 -w0 DeveloperIDApplication.p12
base64 -w0 AuthKey_ABC123XYZ.p8
```

macOS:

```bash
base64 -i DeveloperIDApplication.p12 | tr -d '\n'
base64 -i AuthKey_ABC123XYZ.p8 | tr -d '\n'
```

Create the `.p12` export in Keychain Access from the **Developer ID Application** identity and its private key. Create the `.p8` key in App Store Connect → Users and Access → Integrations/Keys (menu labels may vary); download the `.p8` file when prompted and keep it private.

## Rebuild and verify

1. Commit the updated project to `main`.
2. Open **Actions → Build and Publish mswnlink Executables → Run workflow** and select `main`.
3. Leave `release_tag` blank for the first verification run.
4. Both macOS jobs now validate the app with `codesign`, `spctl`, and `xcrun stapler validate`. The job fails if the signature or notarization ticket is missing or invalid.
5. Only after all jobs pass should you run the workflow with a new release tag to publish the artifacts.

If you do not have these Apple credentials, you can build a local development `.app`, but there is no legitimate source-only switch that removes Gatekeeper's warning. Do not instruct users to disable Gatekeeper to use a public release.
