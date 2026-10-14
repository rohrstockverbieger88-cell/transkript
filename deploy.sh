#!/bin/sh
# Baut die Seite und veröffentlicht sie auf GitHub Pages (Branch gh-pages).
set -e
REPO="git@github.com:rohrstockverbieger88-cell/transkript.git"
npm run build
cd dist
touch .nojekyll
git init -q -b gh-pages
git add -A
git commit -qm "Deploy $(date '+%Y-%m-%d %H:%M')"
git push -f "$REPO" gh-pages
rm -rf .git
echo "✅ Online: https://rohrstockverbieger88-cell.github.io/transkript/"
