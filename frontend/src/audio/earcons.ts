// earcons.ts
// Distinct short tones for game events. Generated via WebAudio to avoid file deps.

export type EarconType =
  | "recordingStarted"
  | "recordingStopped"
  | "sendCancelled"
  | "correctionIncoming"
  | "attemptPassed"
  | "attemptFailed";

// Global audio context, lazy-created on first use (Web Audio requires user gesture)
let audioContext: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!audioContext) {
    audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
  }
  return audioContext;
}

// Two-note blip: freq1 → freq2 over duration, returns web audio promise
function playTwoNoteBleip(
  freq1: number,
  freq2: number,
  duration: number = 0.15,
  volume: number = 0.3
): Promise<void> {
  return new Promise(resolve => {
    const ctx = getAudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.connect(gain);
    gain.connect(ctx.destination);

    gain.gain.setValueAtTime(volume, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + duration);

    osc.frequency.setValueAtTime(freq1, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(freq2, ctx.currentTime + duration);

    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + duration);

    setTimeout(() => resolve(), duration * 1000);
  });
}

// Single thud: low freq, rapid decay
function playThud(duration: number = 0.1, volume: number = 0.3): Promise<void> {
  return new Promise(resolve => {
    const ctx = getAudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.connect(gain);
    gain.connect(ctx.destination);

    gain.gain.setValueAtTime(volume, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + duration);

    osc.frequency.setValueAtTime(80, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(40, ctx.currentTime + duration);

    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + duration);

    setTimeout(() => resolve(), duration * 1000);
  });
}

// Double tick: two short clicks
function playDoubleTick(duration: number = 0.05, volume: number = 0.25): Promise<void> {
  return new Promise(async resolve => {
    const ctx = getAudioContext();

    // First tick
    {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      gain.gain.setValueAtTime(volume, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + duration);
      osc.frequency.value = 800;
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + duration);
    }

    // Wait and play second tick
    await new Promise(r => setTimeout(r, duration * 500));

    {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      gain.gain.setValueAtTime(volume, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + duration);
      osc.frequency.value = 800;
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + duration);
    }

    setTimeout(() => resolve(), duration * 1000 * 1.5);
  });
}

// Bright chime: rising frequencies
function playChime(duration: number = 0.2, volume: number = 0.3): Promise<void> {
  return new Promise(resolve => {
    const ctx = getAudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.connect(gain);
    gain.connect(ctx.destination);

    gain.gain.setValueAtTime(volume, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + duration);

    osc.frequency.setValueAtTime(1000, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(1600, ctx.currentTime + duration * 0.6);
    osc.frequency.exponentialRampToValueAtTime(1200, ctx.currentTime + duration);

    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + duration);

    setTimeout(() => resolve(), duration * 1000);
  });
}

// Muted buzz: lower frequency, harsh decay
function playBuzz(duration: number = 0.15, volume: number = 0.2): Promise<void> {
  return new Promise(resolve => {
    const ctx = getAudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.connect(gain);
    gain.connect(ctx.destination);

    gain.gain.setValueAtTime(volume, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + duration);

    osc.frequency.setValueAtTime(200, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(150, ctx.currentTime + duration);

    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + duration);

    setTimeout(() => resolve(), duration * 1000);
  });
}

// Main earcon player
export async function playEarcon(type: EarconType): Promise<void> {
  try {
    switch (type) {
      case "recordingStarted":
        // Rising two-note blip: 600 → 900 Hz
        await playTwoNoteBleip(600, 900, 0.12, 0.4);
        break;

      case "recordingStopped":
        // Falling two-note blip: 900 → 600 Hz (inverse of start)
        await playTwoNoteBleip(900, 600, 0.12, 0.4);
        break;

      case "sendCancelled":
        await playThud(0.1, 0.3);
        break;

      case "correctionIncoming":
        await playDoubleTick(0.04, 0.28);
        break;

      case "attemptPassed":
        await playChime(0.18, 0.35);
        break;

      case "attemptFailed":
        await playBuzz(0.15, 0.22);
        break;
    }
  } catch (err) {
    // Silently ignore Web Audio errors (may fail in some contexts)
    console.debug("Earcon playback failed:", err);
  }
}
