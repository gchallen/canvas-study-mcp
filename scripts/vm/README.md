# Claude Desktop Install Test

A real install of the bundle in Claude Desktop, in a headless macOS VM under Parallels, against the local Canvas. It covers what nothing else does: the install and settings dialogs, the token prompt, Claude Desktop's built-in Node, and Claude actually choosing and calling a tool.

```sh
scripts/vm/vm.sh up                       # start the VM, firewall it, tunnel in the local Canvas
scripts/vm/install-test.sh                # install, configure, enable; check the server started
scripts/vm/install-test.sh --prompt       # also send one prompt and check Canvas saw the request
scripts/vm/vm.sh shot                     # screenshot to scripts/vm/shots/latest.png
scripts/vm/vm.sh down
```

## Before Running

- `.env.local` is filled in from `.env.local.example`: where the local Canvas lives, and the clean VM image and its account.
- The local Canvas is up and seeded, and `.env` holds the student token (see the main README).
- The VM exists (`vm.sh create`, cloned from the clean macOS image named in `.env.local`) and Claude Desktop in it is signed in. Sign-in is the one manual step: open the VM's window from Parallels and do it there.
- No extension is installed in the VM. Save a signed-in copy once with `vm.sh down && vm.sh save-clean`, and return to it with `vm.sh restore-clean`.

## How It Works

- The VM takes keystrokes (`prlctl send-key-event` through `keys.py`) and gives screenshots, but no mouse. Dialog buttons are reached with Tab, which needs macOS keyboard navigation on (`AppleKeyboardUIMode`) before Claude Desktop starts.
- Results are judged from logs, not the screen: Claude Desktop's `mcp-server-Canvas Study.log` in the VM, and the Canvas container's request log.
- The VM is firewalled off from this Mac's private services. Canvas reaches it through a reverse SSH tunnel to the guest's port 443, with the Canvas name pointed at loopback in the guest's `/etc/hosts`.
- The test bundle (`pack-mcpb.mjs --test-insecure-tls`) turns off certificate checking, because Claude Desktop gives extensions a scrubbed environment and its Node ignores `NODE_EXTRA_CA_CERTS`. That bundle is for this VM only.

## Cautions

- **The keystrokes are blind.** The script cannot see where focus is. If Claude Desktop's dialogs change, or it opens somewhere unexpected, text goes to the wrong place. On failure, look at `shots/failure.png` before retrying.
- **Use a test account in the VM.** Claude Desktop lists the signed-in account's sessions, including live remote-control ones, and a stray shortcut can open one (Command-1 opens the first session in the sidebar). With a real account signed in, do not run this unattended.
- The `--prompt` step depends on the model choosing the tool, so treat a failure there as a reason to look, not as a regression by itself.
- Reinstalling the same version does not replace an installed extension; uninstall first or restore the clean VM.
- Don't take Parallels snapshots of a running macOS VM; copy the stopped bundle instead (`save-clean`).
