"""Human-readable correction transcript (chat_log_{lang}.md) — append-only,
meant for manual accuracy review, not consumed by the app.
"""
from datetime import datetime
from pathlib import Path

from settings import API_ROOT


def get_log_file(lang_code: str) -> Path:
    path = API_ROOT / f"chat_log_{lang_code}.md"
    if not path.exists():
        lang_names = {"es": "Spanish", "id": "Indonesian"}
        lang_name = lang_names.get(lang_code, lang_code.upper())
        path.write_text(
            f"# Chat Log — {lang_name}\n\n"
            "**Instructions for reviewer:** Go through each entry below and evaluate two things:\n\n"
            "1. **Correction quality** — Was the correction accurate? If the original sentence was changed, was the change actually necessary and correct? If it was marked 'sounds natural', was that a fair assessment?\n"
            "2. **Naturalness** — Does the corrected sentence sound like something a native speaker would actually say in casual conversation? Flag anything that sounds overly formal, unnatural, or awkward.\n\n"
            "Note: Punctuation and accent marks are intentionally not corrected by the app — please ignore those.\n\n"
            "---\n",
            encoding="utf-8"
        )
    return path


def append_chat_log(session_id: str, user_input: str, corrected_input: str, had_errors: bool, error_explanation: str, input_intent: str, lang_code: str = "es"):
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    lines = [f"\n---\n### {ts}  (session: {session_id})\n"]

    lines.append(f"**You said:**\n{user_input}\n")

    was_corrected = corrected_input and corrected_input.strip() != user_input.strip()
    if was_corrected:
        lines.append(f"**Corrected:**\n{corrected_input}\n")
    else:
        lines.append("**Corrected:** ✓ No change\n")

    if error_explanation:
        lines.append(f"**Feedback:**\n{error_explanation}\n")
    elif not had_errors and input_intent == "spanish":
        lines.append("**Feedback:** ✓ sounds natural\n")

    try:
        with open(get_log_file(lang_code), "a", encoding="utf-8") as f:
            f.write("\n".join(lines))
    except Exception as e:
        print(f"[LOG] Failed to write chat log: {e}")
