#!/usr/bin/env bash
# The Parallels macOS VM used to test a real install in Claude Desktop against the local Canvas.
# See scripts/vm/README.md.
#
#   vm.sh create          clone the clean image into a new VM, set it up, install Claude Desktop
#   vm.sh up              start (headless), sign in at the console, firewall, tunnel to local Canvas
#   vm.sh down            close the tunnel and stop the VM
#   vm.sh ssh [cmd...]    run a command in the VM as its user (root: vm.sh root [cmd...])
#   vm.sh put <file> <remote>
#   vm.sh keys <token>... send keystrokes (see keys.py), then screenshot
#   vm.sh shot [file]     screenshot the VM's screen (default: scripts/vm/shots/latest.png)
#   vm.sh save-clean / restore-clean   keep or restore a copy of the VM bundle (VM must be stopped)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Machine-specific settings (see .env.local.example).
# shellcheck disable=SC1091
[ -f "$HERE/../../.env.local" ] && { set -a; . "$HERE/../../.env.local"; set +a; }

VM="${CANVAS_STUDY_VM:-canvas-study}"
BUNDLE="$HOME/Parallels/$VM.macvm"
IMAGES="$HOME/Parallels/$VM-images"
CLEAN_SOURCE="${CANVAS_STUDY_VM_SOURCE:?set CANVAS_STUDY_VM_SOURCE in .env.local}"
SOURCE_KEY="$(dirname "$CLEAN_SOURCE")/vm_key"
# The guest account comes with the clean image this VM is cloned from.
GUEST_USER="${CANVAS_STUDY_VM_USER:?set CANVAS_STUDY_VM_USER in .env.local}"
GUEST_PASSWORD="${CANVAS_STUDY_VM_PASSWORD:?set CANVAS_STUDY_VM_PASSWORD in .env.local}"
CANVAS_URL="${CANVAS_URL:?set CANVAS_URL in .env.local}"
CANVAS_HOST="${CANVAS_URL#https://}"
SHOTS="$HERE/shots"
TUNNEL_SOCKET="$IMAGES/tunnel.sock"
SSH_OPTS=(-i "$IMAGES/vm_key" -o UserKnownHostsFile=/dev/null -o StrictHostKeyChecking=no -o LogLevel=ERROR
  -o BatchMode=yes -o ServerAliveInterval=15 -o ControlMaster=no -o ControlPath=none)

say() { echo "vm: $*" >&2; }
state() { prlctl status "$VM" 2>/dev/null | awk '{print $NF}'; }

address() {
  local mac ip
  mac="$(prlctl list -i "$VM" | sed -n 's/.*net0 .*mac=\([0-9A-Fa-f]\{12\}\).*/\1/p' | tr 'A-F' 'a-f')"
  [ -n "$mac" ] || { say "no MAC address for $VM; is it registered?"; exit 1; }
  for _ in $(seq 1 60); do
    ip="$(grep -i "$mac" /Library/Preferences/Parallels/parallels_dhcp_leases 2>/dev/null | tail -1 | cut -d= -f1 | tr -d ' ')"
    [ -n "$ip" ] && { echo "$ip"; return; }
    sleep 2
  done
  say "$VM never took a DHCP lease"; exit 1
}

guest() { ssh "${SSH_OPTS[@]}" "$GUEST_USER@$(address)" "$@"; }
guest_root() { ssh "${SSH_OPTS[@]}" "root@$(address)" "$@"; }
keys() { python3 "$HERE/keys.py" "$VM" "${SHOT_FILE:-$SHOTS/latest.png}" "${KEY_WAIT:-1}" "$@"; }

wait_for_ssh() {
  local ip; ip="$(address)"
  for _ in $(seq 1 60); do nc -z -G 2 "$ip" 22 2>/dev/null && return; sleep 3; done
  say "SSH never came up at $ip"; exit 1
}

console_signed_in() { guest who | grep -q console; }

sign_in_console() {
  console_signed_in && return
  say "signing in at the console"
  sleep 10
  for _ in 1 2 3; do
    keys "text:$GUEST_PASSWORD" return >/dev/null
    for _ in $(seq 1 20); do console_signed_in && return; sleep 1.5; done
  done
  say "never signed in at the console"; exit 1
}

# This Mac publishes other projects' services on every interface, so the VM may reach nothing
# private but DNS and DHCP. Canvas comes in over a reverse SSH tunnel instead.
fence() {
  guest_root 'cat > /private/var/tmp/canvas-study-pf.conf; pfctl -Ef /private/var/tmp/canvas-study-pf.conf >/dev/null 2>&1 || true' <<'EOF'
set skip on lo0
pass out quick proto tcp from any port 22
pass out quick proto { tcp udp } to 10.211.55.1 port 53
pass out quick proto udp to any port 67
block drop out quick inet to { 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16 }
block drop out quick inet6 to { fc00::/7 fe80::/10 }
pass all
EOF
  guest 'nc -z -G 3 10.211.55.2 443 && echo open || echo blocked' | grep -q blocked ||
    { say "the VM can still reach this Mac's services; the firewall is not on"; exit 1; }
  guest_root "grep -q '$CANVAS_HOST' /etc/hosts || echo '127.0.0.1 $CANVAS_HOST' >> /etc/hosts"
}

# Puts the mkcert root in the VM for curl and for Node started from a shell. Claude Desktop's own
# Node ignores NODE_EXTRA_CA_CERTS, which is why the test bundle turns certificate checking off.
# launchctl setenv does not survive a reboot.
trust_local_ca() {
  scp "${SSH_OPTS[@]}" -q "$(mkcert -CAROOT)/rootCA.pem" "$GUEST_USER@$(address):mkcert-rootCA.pem"
  guest_root "launchctl asuser \$(id -u $GUEST_USER) launchctl setenv NODE_EXTRA_CA_CERTS /Users/$GUEST_USER/mkcert-rootCA.pem"
}

tunnel_up() {
  [ -S "$TUNNEL_SOCKET" ] && ssh -S "$TUNNEL_SOCKET" -O check x 2>/dev/null && return
  rm -f "$TUNNEL_SOCKET"
  ssh "${SSH_OPTS[@]}" -o ControlMaster=yes -o ControlPath="$TUNNEL_SOCKET" -f -N -o ExitOnForwardFailure=yes \
    -R 127.0.0.1:443:127.0.0.1:443 "root@$(address)"
  guest "curl -s --cacert ~/mkcert-rootCA.pem -o /dev/null -w '%{http_code}' https://$CANVAS_HOST/login/canvas" | grep -q 200 ||
    say "warning: Canvas is not answering through the tunnel; is the local Canvas up?"
}

tunnel_down() {
  [ -S "$TUNNEL_SOCKET" ] && ssh -S "$TUNNEL_SOCKET" -O exit x 2>/dev/null || true
  rm -f "$TUNNEL_SOCKET"
}

install_claude() {
  local url
  url="$(curl -fsS https://formulae.brew.sh/api/cask/claude.json | python3 -c 'import json,sys; print(json.load(sys.stdin)["url"])')"
  say "downloading Claude Desktop in the VM"
  guest "cd ~ && curl -fsSL -o Claude.zip '$url' && rm -rf /Applications/Claude.app && ditto -x -k Claude.zip /Applications/ && rm Claude.zip && spctl -a /Applications/Claude.app"
}

cmd_up() {
  if [ "$(state)" != "running" ]; then
    prlctl set "$VM" --startup-view headless --on-window-close keep-running >/dev/null
    say "starting $VM (headless)"
    prlctl start "$VM" >/dev/null
  fi
  wait_for_ssh
  sign_in_console
  fence
  trust_local_ca
  tunnel_up
  say "up at $(address)"
}

cmd_down() {
  tunnel_down
  [ "$(state)" = "running" ] || return 0
  prlctl stop "$VM" >/dev/null 2>&1 || true
  # macOS often refuses a clean stop, and "stopping" can fall back to running.
  [ "$(state)" = "stopped" ] || prlctl stop "$VM" --kill >/dev/null
}

cmd_create() {
  [ -e "$BUNDLE" ] && { say "$BUNDLE already exists"; exit 1; }
  say "cloning $CLEAN_SOURCE"
  cp -cR "$CLEAN_SOURCE" "$BUNDLE"
  mkdir -p "$IMAGES"
  cp -p "$SOURCE_KEY" "$SOURCE_KEY.pub" "$IMAGES/"
  chmod 600 "$IMAGES/vm_key"
  local uuid
  uuid="$(prlctl register "$BUNDLE" --regenerate-src-uuid | sed -n 's/.*\({[0-9a-f-]*}\).*/\1/p' | head -1)"
  # A clone registers under the source's name with a suffix, so find it by its bundle path.
  uuid="${uuid:-$(prlctl list -a -i | awk -v home="$BUNDLE/" '/^ID:/{id=$2} $0 ~ "Home: " home {print id}')}"
  prlctl set "$uuid" --name "$VM" >/dev/null
  prlctl set "$VM" --device-set net0 --mac auto >/dev/null
  prlctl set "$VM" --shared-clipboard off --shared-cloud off --sh-app-guest-to-host off --sh-app-host-to-guest off --shf-host off >/dev/null
  prlctl set "$VM" --startup-view headless --on-window-close keep-running >/dev/null
  prlctl start "$VM" >/dev/null
  wait_for_ssh
  sign_in_console
  # Passwordless sudo and root over SSH (the tunnel binds port 443 in the guest).
  guest "echo '$GUEST_PASSWORD' | sudo -S -p '' sh -c \"echo '$GUEST_USER ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/canvas-study && chmod 440 /etc/sudoers.d/canvas-study && mkdir -p /var/root/.ssh && cp /Users/$GUEST_USER/.ssh/authorized_keys /var/root/.ssh/ && chmod 700 /var/root/.ssh\""
  # A locked or sleeping screen swallows the test's keystrokes.
  guest_root "pmset -a displaysleep 0 sleep 0 disksleep 0"
  guest "defaults -currentHost write com.apple.screensaver idleTime -int 0"
  cmd_up
  install_claude
  say "created. Sign in to Claude Desktop in the VM once, then: vm.sh down && vm.sh save-clean"
}

cmd_save_clean() {
  [ "$(state)" = "stopped" ] || { say "stop the VM first (vm.sh down)"; exit 1; }
  rm -rf "$IMAGES/$VM-clean.macvm.bak"
  cp -cR "$BUNDLE" "$IMAGES/$VM-clean.macvm.bak"
}

cmd_restore_clean() {
  [ "$(state)" = "stopped" ] || { say "stop the VM first (vm.sh down)"; exit 1; }
  [ -d "$IMAGES/$VM-clean.macvm.bak" ] || { say "no clean copy saved"; exit 1; }
  rm -rf "$BUNDLE"
  cp -cR "$IMAGES/$VM-clean.macvm.bak" "$BUNDLE"
}

mkdir -p "$SHOTS"
case "${1:-}" in
  create) cmd_create ;;
  up) cmd_up ;;
  down) cmd_down ;;
  ssh) shift; guest "$@" ;;
  root) shift; guest_root "$@" ;;
  put) scp "${SSH_OPTS[@]}" -q "$2" "$GUEST_USER@$(address):$3" ;;
  keys) shift; keys "$@" ;;
  shot) prlctl capture "$VM" --file "${2:-$SHOTS/latest.png}" && sips -Z 1400 "${2:-$SHOTS/latest.png}" >/dev/null ;;
  address) address ;;
  install-claude) install_claude ;;
  save-clean) cmd_save_clean ;;
  restore-clean) cmd_restore_clean ;;
  *) sed -n '2,14p' "$0"; exit 1 ;;
esac
