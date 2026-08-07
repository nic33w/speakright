"""Controller -> F13 mapper (TASKS.md task 4.1).

Maps a click of either thumbstick (L3 or R3) on an Xbox controller to a single
F13 tap. F13 is a real keycode no application claims by default; set it as
Wispr's hotkey (in toggle/tap mode, not hold-to-talk) and the browser handles
everything else in-page via the Gamepad/keyboard APIs — no IPC, no backend
router, no custom protocol. This script is a dumb key sender, not an
architecture: it does nothing but watch for the press edge and forward it.

Windows only (XInput). Requires an XInput-aware mapper library — deliberately
not AutoHotkey, whose legacy WinMM joystick support combines LT/RT onto a
single shared axis and would have broken 4.2's LT-hold mapping.

L3/R3 are the only buttons this script touches. Everything task 4.2 added
(A/B/X/Y, the stick-flick cancel, LT-hold-to-translate) reads straight off the
in-page Gamepad API via `useGamepad` in frontend/src/sharedGameHooks.ts — no
native bridge needed there, because none of it has to reach an app outside
the browser the way recording has to reach Wispr.

Setup:
    pip install -r requirements.txt
    python f13_mapper.py

Then in Wispr: set the hotkey to F13, and toggle/tap mode (a single press
starts recording, a second press stops it) rather than hold-to-talk — a tap
in hold-to-talk mode would start and immediately end dictation. Also check
whether Wispr plays its own start/stop sound; if so, disable one side so you
don't get doubled cues against the app's earcons (task 2.3).

Ctrl+C to quit.
"""
import time

import XInput
import keyboard

POLL_HZ = 125
PLAYER = 0  # first connected controller


def main() -> None:
    was_pressed = False
    print(f"Watching controller {PLAYER} for L3/R3 clicks -> F13. Ctrl+C to quit.")
    while True:
        if not XInput.get_connected()[PLAYER]:
            was_pressed = False
            time.sleep(1)
            continue

        buttons = XInput.get_button_values(XInput.get_state(PLAYER))
        pressed = buttons["LEFT_THUMB"] or buttons["RIGHT_THUMB"]

        # Edge-triggered: fire once per press, not once per poll while held, so
        # holding the stick down doesn't flood Wispr with toggles.
        if pressed and not was_pressed:
            keyboard.send("f13")
        was_pressed = pressed

        time.sleep(1 / POLL_HZ)


if __name__ == "__main__":
    main()
