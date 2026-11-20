#!/usr/bin/env python3
"""Keys and screenshots for a Parallels VM. vm.py <vm> <out.png> <wait seconds> <token>...
A token is a key name (return, tab, space, esc, up, down, left, right, backspace), a chord (cmd+space,
shift+tab), or text:<characters to type>."""
import subprocess, sys, time

S = {"esc": 1, "backspace": 14, "tab": 15, "return": 28, "space": 57, "ctrl": 29, "shift": 42, "alt": 56, "cmd": 219, "up": 200, "left": 203, "right": 205, "down": 208, "f2": 60, "f5": 63, "f7": 65, "f10": 68, "end": 95}
ROWS = {"1234567890-=": 2, "qwertyuiop[]": 16, "asdfghjkl;'": 30, "zxcvbnm,./": 44}
for row, start in ROWS.items():
    for i, c in enumerate(row):
        S[c] = start + i
S["`"] = 41
S["\\"] = 43
SHIFTED = dict(zip('!@#$%^&*()_+{}|:"~<>?', "1234567890-=[]\\;'`,./"))
SHIFTED["+"] = "="


def send(vm, code, event):
    # Parallels' virtual keycodes are X11's: a plain scancode plus 8, and the extended keys their own.
    key = {219: 115, 95: 107, 200: 98, 203: 100, 205: 102, 208: 104}.get(code, code + 8)
    subprocess.run(["prlctl", "send-key-event", vm, "--key", str(key), "--event", event], check=True, capture_output=True)


def tap(vm, *names):
    for n in names:
        send(vm, S[n], "press")
    for n in reversed(names):
        send(vm, S[n], "release")
    time.sleep(0.06)


def type_text(vm, text):
    for c in text:
        if c == " ":
            tap(vm, "space")
        elif c == "\n":
            tap(vm, "return")
        elif c.isupper():
            tap(vm, "shift", c.lower())
        elif c in SHIFTED:
            tap(vm, "shift", SHIFTED[c])
        else:
            tap(vm, c)


vm, out, wait = sys.argv[1], sys.argv[2], float(sys.argv[3])
for token in sys.argv[4:]:
    if token.startswith("text:"):
        type_text(vm, token[5:])
    elif token.startswith("sleep:"):
        time.sleep(float(token[6:]))
    else:
        tap(vm, *token.split("+"))
    time.sleep(0.5)
time.sleep(wait)
subprocess.run(["prlctl", "capture", vm, "--file", out], check=True, capture_output=True)
subprocess.run(["sips", "-Z", "1000", out], capture_output=True)
