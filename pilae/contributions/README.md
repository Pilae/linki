# Pilae-only work and upstream contributions

This fork stays a fork of `moaljumaa/linki`; no repository topology change is needed. `.gitignore` is not remote-specific and cannot exclude tracked Pilae code from an upstream push or PR.

Pilae-only features live in dedicated branches and commits based on `origin/main`. This reply feature uses `codex/pilae-linkedin-replies`. Its base is fork commit `68f059f`; the previous local `main` checkpoint `d6a6f2b` remains intact. The newer fork base contains the merged enrollment, localization, metrics and acceptance fixes. No local checkpoint was reset, deleted or force-pushed.

For an upstream contribution:

1. Fetch `upstream` and start a clean branch from `upstream/main`. Do not branch from Pilae main and try to delete the private namespace afterward.
2. Apply only the generic change. Avoid cherry-picking feature commits that also contain Pilae hooks. Keep generic fixes and Pilae integration in separate commits.
3. Run the trusted boundary guard from the Pilae checkout against the candidate ref (both refs must exist in that object database):

   ```sh
   node pilae/contributions/check-upstream.cjs upstream/main codex/upstream-example
   ```

4. Inspect the entire upstream diff, run the relevant tests and review licensing. Only then publish a contribution when the user authorizes it. Never push a fork-only feature branch to upstream.

The automated guard requires the upstream base to be an ancestor, checks every candidate commit including merge deltas, and rejects Pilae namespaces/workflows. It also rejects **all changes** to `instrumentation.ts`, `lib/linkedin/runner.ts`, and `lib/campaign-metrics.ts`, which contain Pilae-specific integration. This intentionally conservative rule catches unmarked or renamed hooks; it will also reject legitimate generic changes to these shared files. Such work requires a separate review of the clean upstream patch and a separately reviewed Pilae guard-policy change before it can pass. Do not weaken the guard in the candidate branch. Update the protected-file set whenever another shared hook is introduced. Marker scanning additionally catches obvious Pilae hooks in other files; it is not semantic proof for arbitrarily disguised new code.

`.github/workflows/pilae-upstream-boundary.yml` runs the guard from the trusted PR base for Pilae PRs labeled `upstream-candidate`. It fetches current upstream main and checks the candidate commits. The workflow becomes available on the default branch only after this draft is merged. Fixture tests exercise both namespaces and shared-file changes without markers.

Enforced when the guard is run: ancestry, known Pilae paths, protected shared files, markers and full commit history. CI can enforce that invocation for appropriately labeled PRs. Not enforced by this code: the developer choosing a clean branch, applying the label, making this a required branch-protection check, maintaining the protected-file list, reviewing disguised semantic changes, and avoiding manual direct pushes. No GitHub branch protection or upstream settings were changed. Keep those workflow dependencies explicit; there is no promise that Git itself prevents an unauthorized export.

The local `pilae-linki-app` and `twenty-linki-sandbox` folders currently belong to the ignored `local/` area of company-brain; neither has its own Git repository. The reply PR versions Linki only. Companion Twenty changes and their reproducible patch remain in the integration folder, rather than creating a repository or promoting personal workspace code into shared company documents without direction.
