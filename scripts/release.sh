#!/usr/bin/env bash
# release.sh: cut a plugin release in two steps.
#
#   npm run release [-- patch|minor]   (default patch)
#     Checks the tree (on master, clean, level with origin, commit identity),
#     runs lint + type check + unit tests, then `npm version` (bumps
#     manifest.json, versions.json and the README badge, commits, tags without
#     a "v"), pushes master with the tag, and waits for the Release workflow,
#     which builds the assets into a DRAFT GitHub release.
#
#   npm run release -- publish <version>
#     Publishes that draft as Latest. Edit its notes first: the generated ones
#     list only pull requests, so most changes are missing.
#
# Major bumps are refused: the plugin stays on 0.x while in beta.
set -euo pipefail

REPO="Papersync/obsidian-papersync"
IDENTITY="contact@papersync.ai"
cd "$(dirname "${BASH_SOURCE[0]}")/.."

die() { echo "release: $*" >&2; exit 1; }

publish() {
	local version="${1:-}"
	[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "usage: npm run release -- publish <x.y.z>"
	local draft
	draft="$(gh release view "$version" --repo "$REPO" --json isDraft --jq .isDraft)" \
		|| die "no release $version on $REPO"
	[[ "$draft" == "true" ]] || die "$version is already published"
	gh release edit "$version" --repo "$REPO" --draft=false --latest >/dev/null
	echo "Published $version: https://github.com/$REPO/releases/tag/$version"
}

cut() {
	local bump="$1"
	case "$bump" in
		patch | minor) ;;
		major) die "major bumps are refused while the plugin is in beta (0.x)" ;;
		*) die "usage: npm run release [-- patch|minor] | npm run release -- publish <x.y.z>" ;;
	esac

	command -v gh >/dev/null || die "the GitHub CLI (gh) is required"
	gh auth status >/dev/null 2>&1 || die "gh is not logged in (gh auth login)"
	[[ "$(git branch --show-current)" == "master" ]] || die "not on master"
	[[ -z "$(git status --porcelain)" ]] || die "uncommitted changes; commit or stash them first"
	[[ "$(git config user.email)" == "$IDENTITY" ]] || die "git user.email must be $IDENTITY in this repo"
	git fetch --quiet origin master --tags
	[[ "$(git rev-parse HEAD)" == "$(git rev-parse origin/master)" ]] \
		|| die "master is not level with origin/master; pull or push first"

	echo "== lint, type check, unit tests"
	npm run --silent lint
	npm run --silent tsc
	npm test --silent

	echo "== npm version $bump"
	npm version "$bump" >/dev/null
	local version
	version="$(node -p 'require("./manifest.json").version')"
	[[ "$(git tag --points-at HEAD)" == *"$version"* ]] || die "npm version did not tag $version"

	echo "== push master + tag $version"
	git push --quiet origin master "refs/tags/$version"

	# The tag push starts the run asynchronously; poll briefly for it to appear.
	echo "== waiting for the Release workflow"
	local run=""
	for _ in $(seq 1 24); do
		run="$(gh run list --repo "$REPO" --workflow release.yml --branch "$version" \
			--limit 1 --json databaseId --jq '.[0].databaseId // empty')"
		[[ -n "$run" ]] && break
		sleep 5
	done
	[[ -n "$run" ]] || die "no Release run for $version after 2 minutes; check GitHub Actions"
	# Every job in release.yml has a timeout-minutes, so this watch is bounded.
	gh run watch "$run" --repo "$REPO" --exit-status >/dev/null \
		|| die "Release run failed: https://github.com/$REPO/actions/runs/$run"

	echo
	echo "Draft $version is ready with main.js, manifest.json and styles.css."
	echo "Changes since the last release:"
	git log --no-merges --format='  - %s' "$(git describe --tags --abbrev=0 HEAD^)..HEAD^"
	echo
	echo "Next: write the notes (gh release edit $version --repo $REPO --notes-file <file>),"
	echo "then publish with: npm run release -- publish $version"
}

case "${1:-patch}" in
	publish) shift; publish "$@" ;;
	*) cut "${1:-patch}" ;;
esac
