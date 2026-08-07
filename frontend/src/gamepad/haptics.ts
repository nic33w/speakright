// haptics.ts
// Controller rumble feedback via the Gamepad API's vibrationActuator (task 4.4).
// With the screen off, audio is already busy narrating the turn — rumble is the
// one channel that can confirm something happened without competing with or
// interrupting that stream, which is what makes eyes-free actually usable
// rather than merely possible.
//
// Deliberately only the three events TASKS.md asks for, not full parity with
// earcons.ts's six — haptics confirm the highest-stakes moments (are you
// recording, did it send, is a correction about to interrupt you), not every
// event that already has a tone.

export type HapticPattern = "recordingStarted" | "sent" | "correctionIncoming";

function firstConnectedGamepad(): Gamepad | null {
  if (typeof navigator === "undefined" || !navigator.getGamepads) return null;
  return Array.from(navigator.getGamepads()).find(p => p?.connected) ?? null;
}

async function pulse(actuator: GamepadHapticActuator, duration: number, strongMagnitude: number, weakMagnitude: number): Promise<void> {
  await actuator.playEffect("dual-rumble", { duration, strongMagnitude, weakMagnitude });
}

export async function playHaptic(pattern: HapticPattern): Promise<void> {
  try {
    const pad = firstConnectedGamepad();
    const actuator = pad?.vibrationActuator;
    if (!actuator) return; // no controller, or this one has no rumble motor

    switch (pattern) {
      case "recordingStarted":
        // Short pulse.
        await pulse(actuator, 120, 0.6, 0.3);
        break;

      case "sent":
        // Double pulse: two short taps with a gap, distinct from the single
        // recording-started pulse by rhythm alone.
        await pulse(actuator, 90, 0.5, 0.25);
        await new Promise(resolve => setTimeout(resolve, 90));
        await pulse(actuator, 90, 0.5, 0.25);
        break;

      case "correctionIncoming":
        // Long buzz — the strongest pattern, since this is the one that's
        // about to interrupt the conversation with a drill.
        await pulse(actuator, 350, 0.85, 0.5);
        break;
    }
  } catch (err) {
    // Vibration is best-effort: unsupported browsers, disconnected controllers,
    // or a rejected playEffect() promise should never break the turn.
    console.debug("Haptic playback failed:", err);
  }
}
