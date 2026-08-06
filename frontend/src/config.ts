// config.ts
// Single source for cross-mode frontend configuration. Import from here — do not
// re-declare these inline in a mode (see CLAUDE.md "Shared conventions").

// Backend base URL. Override with VITE_API_BASE_URL at build time.
export const API_BASE: string =
  import.meta.env.VITE_API_BASE_URL || "http://localhost:8000";

// Language code → Azure TTS locale. Mirrors the locale maps in
// backend/game_backend.py and backend/llm_call.py — keep the three in sync.
export const LOCALE_MAP: Record<string, string> = {
  es: "es-MX",
  id: "id-ID",
  en: "en-US",
};

export const DEFAULT_LOCALE = "es-MX";

// Resolves a language code to its locale, falling back to Spanish.
export function localeFor(langCode: string | undefined | null): string {
  return (langCode && LOCALE_MAP[langCode]) || DEFAULT_LOCALE;
}

// TTS speed for "say that again, slower" (SSML prosody rate, a percent offset
// from normal — see backend/tts_helpers.py). -25 is 0.75x, the repeat-after-me
// speed. It is part of the audio cache key, so slow and normal renderings of the
// same sentence are cached separately.
export const SLOW_TTS_RATE = -25;
