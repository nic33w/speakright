"""Single source for cross-feature prompt rules — edit here, never inline.

Any rule that must hold across modes (STT tolerance, never-penalize
accents/punctuation, language register, naturalness strictness, quiz-candidate
tagging) lives here as a named constant or a small format function, and the
prompt builders compose from these fragments. A rule refined once applies
everywhere. See backend/PROMPTS.md for the full map.
"""


def language_style_instruction(lang_code: str) -> str:
    """Casual register per language — the one authoritative place for
    Spanish/Indonesian style rules (see CLAUDE.md Shared Conventions)."""
    if lang_code == "es":
        return "Prefer Latin American Spanish (lean Mexican). Use colloquial, conversational phrasing."
    if lang_code == "id":
        return "Use casual, conversational Indonesian (everyday register), not formal."
    return "Use natural, conversational American English."


# --- Answer-checking rules (check_trivia_answer: trivia/battle/worddrill/quiz) ---

NEVER_PENALIZE_ACCENTS_RULE = (
    "- CRITICAL: NEVER mention, comment on, or penalize accents, punctuation, or capitalization — not even as a side note. Both the student's answer and the reference have had accents and punctuation stripped before you receive them. The student is speaking (speech-to-text) and has no control over accents or punctuation. Do NOT say things like 'you should include the accent' or 'you forgot the exclamation mark'. Any issue that is ONLY about accents or punctuation must be completely ignored.\n"
)

STT_TOLERANCE_RULE = (
    "- FIRST, before any other evaluation: the student is using speech-to-text (Wispr). Accents and punctuation have already been stripped from the student's answer — do NOT penalize for any accent or punctuation difference. Check if unexpected words are STT mishearings. Common patterns: phonetically similar words (e.g. 'cus'→'jus'), merged or split tokens (e.g. 'Este'→'Es teh', 'S T'→'es teh', 'dise'→'di sini', 'esta'→'es ta', 'está'→'es ta' or 'es esta'), or words run together. If correcting the mishearing makes the answer acceptable, IMMEDIATELY set accepted: true, damage_multiplier: 1.0, issues: [{\"feedback_key\": \"asr_error\", \"corrected_snippet\": null, \"feedback_explanation\": \"<explain what was misheard>\"}]. Do NOT add any other issues in this case.\n"
)

UNNATURAL_PHRASING_RULE = (
    "    unnatural_phrasing: ONLY for phrasing that would genuinely sound foreign or awkward to a native speaker — e.g. word-for-word translation from English, textbook constructions nobody actually says, combinations of correct words that produce a clearly wrong register, OR the wrong preposition in a fixed-preposition idiom (e.g. 'poner en mal humor' instead of 'poner de mal humor', 'depender en' instead of 'depender de'). Fixed-preposition idioms must use their correct preposition — a wrong preposition here is always unnatural_phrasing even if the meaning is clear. Do NOT use for valid regional variants, stylistic preferences, or choosing one natural phrasing over another equally natural one.\n"
)


# --- Messenger fragments (build_layered_prompt) ---
# (The messenger naturalness rule is stated once, inline in the had_errors
# schema comment — deduplicated per SPEAKING_LISTENING_ANALYSIS.md §9a.)

def quiz_candidate_rules(ui_lang: str, target_lang: str) -> str:
    """Messenger quiz-candidate tagging rules (only sent when ENABLE_QUIZZING)."""
    return f"""
QUIZ CANDIDATE RULES:
- ONLY tag SIGNIFICANT errors (verb conjugation, gender, prepositions, vocabulary gaps, grammar structure, ser/estar, por/para)
- Also tag clearly unnatural phrasing when had_errors=true for naturalness reasons
- DO NOT tag minor errors (accents, punctuation, typos, capitalization)
- For vocabulary gaps (user used {ui_lang}), type="translation"; for grammar errors, type="correction"; for unnatural phrasing, type="naturalness"
- "original": what the user said; "corrected": the correct/natural {target_lang} word/phrase (QUIZ ANSWER)
- "quiz_prompt": question in {ui_lang} like "How do you say 'X' in {target_lang}?\""""


# --- Story cards rules (_make_prompt) ---

STORY_CARDS_RULES = (
    "Rules:\n"
    "- corrected_sentence must be ONE natural sentence in the learning language (use colloquial Latin-American Spanish for es, casual Indonesian for id).\n"
    "- native_translation must be a natural translation into the fluent/native language.\n"
    "- audio_chunks must include the corrected_sentence chunk first, then the native_translation chunk, each with a proper lang tag (es-MX, id-ID, en-US).\n"
    "- Return only JSON (no commentary, no markdown).\n"
)


# --- Chat-log reviewer header (chat_log.get_log_file) ---

CHAT_LOG_REVIEWER_INSTRUCTIONS = (
    "**Instructions for reviewer:** Go through each entry below and evaluate two things:\n\n"
    "1. **Correction quality** — Was the correction accurate? If the original sentence was changed, was the change actually necessary and correct? If it was marked 'sounds natural', was that a fair assessment?\n"
    "2. **Naturalness** — Does the corrected sentence sound like something a native speaker would actually say in casual conversation? Flag anything that sounds overly formal, unnatural, or awkward.\n\n"
    "Note: Punctuation and accent marks are intentionally not corrected by the app — please ignore those.\n\n"
    "---\n"
)
