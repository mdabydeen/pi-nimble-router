# npm release checklist

This document records the release boundary for publishing `pi-nimble-router` to npm. It does not claim that npm is currently a supported Pi installation source.

## Before publishing

1. Confirm the package name and target version with `npm view pi-nimble-router version`.
2. Authenticate the release account with `npm whoami`.
3. Run `npm test`.
4. Inspect `npm pack --dry-run --json` and confirm that only the intended seven package files are included.
5. Run `git diff --check` and confirm that the release commit is pushed to the public repository.

## Publish

Run the publish command from the release commit:

```sh
npm publish --access public
```

Do not publish with a copied token in shell history or commit any credential. If npm requests an interactive login or one-time verification, stop and complete that step manually.

## After publishing

1. Verify the registry record with `npm view pi-nimble-router version dist-tags --json`.
2. Compare the registry version with the GitHub release tag and package contents.
3. Only then consider an npm link in public copy. The README's pinned GitHub install command remains the canonical Pi installation path until Pi's package-source compatibility with npm is verified.
4. Record the package version, registry read-back, and any download count as discovery evidence only. Do not infer adoption or revenue from publication alone.
