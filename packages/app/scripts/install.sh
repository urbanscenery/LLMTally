#!/bin/sh
# Installs the menubar app into /Applications: rebuild the bundle, quit
# the running instance, replace the installed copy, relaunch. The bundle
# is self-contained (bundle.sh embeds the sidecar), so the installed copy
# carries no reference back to this checkout.
#
#   LLMTALLY_APP_DIR=~/Applications sh packages/app/scripts/install.sh
#
# Launch at login (Settings → General) registers by bundle id; after the
# first install, toggle it off and on once so LaunchServices points at
# the /Applications copy rather than build/.
set -eu
cd "$(dirname "$0")/.."

sh scripts/bundle.sh

DEST_DIR="${LLMTALLY_APP_DIR:-/Applications}"
DEST="$DEST_DIR/LLMTally.app"
if [ ! -d "$DEST_DIR" ]; then
    echo "install: destination directory does not exist: $DEST_DIR" >&2
    exit 1
fi

# The app enforces a single instance (the older pid wins), so the old
# copy must be gone before the new one opens. The sidecar exits on its
# own when the app's stdin pipe closes.
pkill -x LLMTally 2>/dev/null || true
for _ in $(seq 1 40); do
    pgrep -x LLMTally >/dev/null 2>&1 || break
    sleep 0.25
done
if pgrep -x LLMTally >/dev/null 2>&1; then
    echo "install: LLMTally is still running; quit it and retry" >&2
    exit 1
fi

# ditto keeps the ad-hoc signature and extended attributes intact
rm -rf "$DEST"
ditto build/LLMTally.app "$DEST"
open "$DEST"
echo "installed $DEST"
