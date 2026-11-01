# Releasing Papersync

Releases have three separate stages: prepare a version through a PR, request a
draft from tested merged source, then publish the reviewed draft. Use npm and the
Node version in `.nvmrc`. The scripts need git and an authenticated GitHub CLI
with access to `Papersync/obsidian-papersync`.

Agents must have the founder's explicit approval before pushing, creating a
release, publishing, changing repository visibility, or submitting to Obsidian.
Running `draft` pushes a tag and requests a draft release. Running `publish`
makes the draft available to users. These are separate approvals.

## 1. Prepare the version through a PR

Start from the latest default branch (currently `master`), then create a release
branch. The working tree must be clean. For example, after 0.1.4 is released:

```bash
git switch master
git pull --ff-only
git switch -c release/0.1.5
npm run release -- prepare patch
```

Use `prepare minor` for a minor release. Major versions are disabled while the
plugin is in beta. `prepare` runs lint, both TypeScript configurations, release
script tests, unit coverage and a production build. It then updates
`package.json`, `package-lock.json`, `manifest.json`, `versions.json` and the README
badge, and creates one `chore(release): <version>` commit as
`Papersync <contact@papersync.ai>`. It creates no tag and makes no remote changes.

After approval, push the branch and open a PR:

```bash
git push -u origin HEAD
gh pr create --base master --title 'chore(release): 0.1.5'
```

Wait for the PR's **verify** and **e2e** jobs, then merge. Pull the merged default
branch and wait for its own Verify workflow to pass. The draft command checks
the exact merged commit, including both jobs; passing PR checks alone are not
enough after a squash or rebase changes the commit hash.

The helper discovers the default branch from GitHub, so a future rename to
`main` does not require changing it. Substitute that branch in these examples.
Running `npm run release` without arguments only shows help. The old implicit
bump-and-push command is intentionally no longer supported.

## 2. Request a draft from the merged version

For the already-merged 0.1.4, **skip prepare**. Its version bump is done.

```bash
git switch master
git pull --ff-only
npm run release -- draft 0.1.4
```

The working tree must be clean and match the remote default-branch commit. The
helper verifies package/lock/manifest/history consistency and a successful
default-branch Verify run for that exact commit, including **verify** and **e2e**.
It creates an annotated tag named exactly `0.1.4` with the Papersync identity and
pushes **only that tag**. It does not bump again or push the default branch.

The tag starts [Release](https://github.com/Papersync/obsidian-papersync/actions/workflows/release.yml).
That workflow builds a **draft**, with separate `main.js`, `manifest.json` and
`styles.css` assets. A public repository also gets build attestations. The command
returns after the tag push; watch the workflow in GitHub before proceeding.

Tags have no `v` prefix and are immutable. A rerun can resume a tag push that
failed after local tag creation, or recognize an existing tag on the same source.
It never overwrites a tag. A tag pointing elsewhere, an existing published
release, or a source/CI mismatch stops the command.

If Release fails, fix the underlying problem and rerun that workflow when the
same source remains valid. Do not delete or move the tag. If source must change,
prepare a new patch version through a PR. If the default branch has advanced,
an older draft can still be published from its own verified tag in stage 3.

## 3. Review and publish

After the Release workflow succeeds:

1. Review the draft's notes. Generated notes may omit changes made without PRs.
2. Download and inspect all three assets. Confirm the manifest version, exact
   tag and release title agree. The source archive is not a substitute for assets.
3. Confirm both Verify and Release succeeded on the tagged source.
4. With explicit publication approval, publish:

   ```bash
   npm run release -- publish 0.1.4
   ```

The publish command rechecks the remote tag's source metadata, both Verify jobs,
the Release build/draft jobs, draft status, non-empty notes and all three assets.
It downloads the manifest asset to a temporary directory and compares it with
the tagged source before publishing. Temporary files are removed on success or
failure. It publishes the existing draft as Latest without bumping or retagging.

After a failed publish request, check the release in GitHub before retrying: the
request may have succeeded even if its response was lost. An already-published
release is never rewritten by this helper.

For launch, repository visibility and submission to the Obsidian community
dashboard remain separate founder-approved actions. The repository goes public
when the phone app is live on Play. Later plugin updates use normal GitHub
releases; they do not need another directory submission.

## Validation and recovery

Run `npm run test:release` to exercise the helper against temporary git
repositories and stubbed GitHub/npm checks. These tests never contact GitHub or
create real releases. CI runs them in Verify and Release.

Local checks normally finish in about two minutes. Hard ceilings per command are
2 minutes for lint/release tests/build, 3 for types, 5 for unit coverage, 1 for
the version bump, and 30 seconds for each git/GitHub request. A timeout or signal
stops the command's own process group. Completed local changes or a pushed tag
are retained for inspection; the helper never force-resets your branch, deletes
tags, or rolls back someone else's work. Inspect `git status` after a failed
prepare before resuming. No stage merges a PR, changes visibility or submits a
directory entry.
