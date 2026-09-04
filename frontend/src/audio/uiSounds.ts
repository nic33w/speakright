// uiSounds.ts
// File-backed UI sounds. The home for any interface audio that is a recording
// rather than a generated tone.
//
// Sibling to `earcons.ts`, which synthesizes short blips via WebAudio to avoid
// file dependencies. The split is deliberate and worth keeping:
//
//   earcons.ts  — abstract signals (send cancelled, recording started). Generated,
//                 so there is nothing to ship and no load to wait for.
//   uiSounds.ts — recorded sounds with a character of their own (a bell, a voice).
//                 Files, served from `frontend/public/ui/`.
//
// TO ADD A SOUND: drop the file in `frontend/public/ui/` and add a line to
// `UI_SOUNDS`. Nothing else needs to change.
export type UiSound = "ring";

const UI_SOUNDS: Record<UiSound, string> = {
  ring: "/ui/ring.wav",
};

// One Audio element per sound, reused. Recreating it per play leaks elements on a
// screen that fires the same sound often, and re-fetches on some browsers.
const cache = new Map<UiSound, HTMLAudioElement>();

/** Play a UI sound. Never throws and never blocks the caller — a UI sound failing
 *  must not take an interaction down with it. */
export function playUiSound(name: UiSound, volume = 0.6): void {
  try {
    let audio = cache.get(name);
    if (!audio) {
      audio = new Audio(UI_SOUNDS[name]);
      cache.set(name, audio);
    }
    audio.volume = volume;
    // Rewind so rapid repeats retrigger instead of being ignored mid-play.
    audio.currentTime = 0;
    void audio.play().catch(() => {
      // Autoplay policy, or the file is missing. Silence is an acceptable outcome
      // for a confirmation sound.
    });
  } catch {
    // Same reasoning: never let a decoration break the thing it decorates.
  }
}

/** Warm the file so the first play is not delayed. Safe to call repeatedly. */
export function preloadUiSound(name: UiSound): void {
  try {
    if (!cache.has(name)) {
      const audio = new Audio(UI_SOUNDS[name]);
      audio.preload = "auto";
      cache.set(name, audio);
    }
  } catch {
    // Nothing to do; playUiSound will construct it on demand.
  }
}
