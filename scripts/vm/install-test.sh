#!/usr/bin/env bash
# Installs the test bundle in Claude Desktop inside the VM, by keystrokes, and checks from logs that
# the server started and that a prompt led to a real request to the local Canvas.
# See scripts/vm/README.md for what must be true before running this.
#
#   install-test.sh            install, configure, enable, check the server started
#   install-test.sh --prompt   also send one prompt and check Canvas saw the request
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
VM_SH="$HERE/vm.sh"
SERVER_LOG='Library/Logs/Claude/mcp-server-Canvas Study.log'
EXTENSIONS='Library/Application Support/Claude/Claude Extensions'

say() { echo "install-test: $*" >&2; }
fail() { say "FAIL: $*"; "$VM_SH" shot "$HERE/shots/failure.png" >/dev/null 2>&1 || true; exit 1; }
keys() { KEY_WAIT="${WAIT:-2}" "$VM_SH" keys "$@" >/dev/null; }
guest() { "$VM_SH" ssh "$@"; }

# shellcheck disable=SC1091
set -a; . "$ROOT/.env"; . "$ROOT/.env.local"; set +a
CANVAS_DIR="${CANVAS_DIR:?set CANVAS_DIR in .env.local}"
CANVAS_HOST="${CANVAS_URL#https://}"
[ -n "${CANVAS_API_TOKEN:-}" ] || fail "no CANVAS_API_TOKEN in .env; run scripts/seed-local-canvas.mjs"

"$VM_SH" up
guest "ls '$EXTENSIONS' 2>/dev/null | grep -q ." && fail "an extension is already installed; restore the clean VM first"

say "building the test bundle"
(cd "$ROOT" && npm run build >/dev/null && node scripts/pack-mcpb.mjs --test-insecure-tls >/dev/null)
"$VM_SH" put "$ROOT/canvas-study-test.mcpb" canvas-study-test.mcpb

# Tab reaches dialog buttons only with keyboard navigation on, and Claude must start after it is set.
guest "defaults write NSGlobalDomain AppleKeyboardUIMode -int 2; pkill -x Claude; sleep 3; rm -f '$SERVER_LOG'; open -a Claude ~/canvas-study-test.mcpb"
sleep 12

say "install"
WAIT=3 keys tab return        # Install on the extension page
WAIT=6 keys tab space         # Install in the native confirmation
say "configure"
keys "text:$CANVAS_HOST" tab "text:$CANVAS_API_TOKEN" tab tab
WAIT=4 keys return            # Save
WAIT=6 keys tab space         # Save in the native confirmation
say "enable"
WAIT=6 keys shift+tab space   # the Disabled/Enabled switch
keys esc

guest "grep -q 'method=\"tools/list\"' '$SERVER_LOG'" || fail "the server never listed its tools"
say "PASS: installed, configured, enabled, and the server listed its tools"

[ "${1:-}" = "--prompt" ] || exit 0

# A relaunch opens on a new, empty chat with the message box focused.
since="$(date -u +%Y-%m-%dT%H:%M:%S)"
guest "pkill -x Claude; sleep 3; open -a Claude"
sleep 12
keys "text:Use Canvas Study to tell me what I have due in the next two weeks."
WAIT=15 keys return
keys cmd+return               # Allow once
WAIT=25 keys cmd+return       # and again to confirm

guest "grep -q 'method=\"tools/call\"' '$SERVER_LOG'" || fail "Claude never called a Canvas Study tool"
# shellcheck disable=SC1091
seen="$(cd "$CANVAS_DIR" && . ./env.sh && compose exec -T canvas sh -c 'grep -a "Started GET \"/api/v1/courses" log/development.log | tail -1')"
stamp="$(echo "$seen" | sed -n 's/.* at \([0-9-]*\) \([0-9:]*\) .*/\1T\2/p')"
[ -n "$stamp" ] && [ "$stamp" \> "$since" ] || fail "Canvas saw no request after the prompt (last: ${stamp:-none})"
"$VM_SH" shot "$HERE/shots/answer.png" >/dev/null
say "PASS: Claude called the tool and Canvas answered; see scripts/vm/shots/answer.png"
