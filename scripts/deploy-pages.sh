#!/usr/bin/env bash
#
# Publish dist/ to the gh-pages branch.
#
# dist/ is gitignored and never committed to main, so instead of git-subtree
# this makes dist/ a throwaway repo and force-pushes it as gh-pages. The branch
# holds only build output, so a single-commit history is exactly what we want.
#
# Usage: npm run deploy
set -euo pipefail

cd "$(dirname "$0")/.."

REMOTE=$(git remote get-url origin)
REV=$(git rev-parse --short HEAD)

npm run build

# Pages runs Jekyll on branch deploys, which would swallow any path starting
# with an underscore. Opt out.
touch dist/.nojekyll

rm -rf dist/.git
git -C dist init -q
git -C dist add -A
git -C dist commit -q -m "deploy ${REV}"
git -C dist push -q -f "$REMOTE" HEAD:gh-pages
rm -rf dist/.git

echo "pushed dist/ (${REV}) to gh-pages"
