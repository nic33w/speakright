# llm_call.py
import os
import json
import re
import unicodedata
from typing import Any, Dict, List, Optional

try:
    # modern OpenAI client
    from openai import OpenAI
except Exception:
    OpenAI = None

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
AZURE_OPENAI_API_KEY = os.getenv("AZURE_OPENAI_API_KEY")
AZURE_OPENAI_BASE_URL = os.getenv("AZURE_OPENAI_BASE_URL")
DEFAULT_MODEL = os.getenv("OPENAI_MODEL", "gpt-4.1-mini")
MOCK_MODE = os.getenv("MOCK_MODE", "1") == "1"

def _language_style_instruction(lang_code: str) -> str:
    if lang_code == "es":
        return "Prefer Latin American Spanish (lean Mexican). Use colloquial, conversational phrasing."
    if lang_code == "id":
        return "Use casual, conversational Indonesian (everyday register), not formal."
    return "Use natural, conversational American English."

def _to_plain(obj):
    if obj is None:
        return None
    if hasattr(obj, "dict") and callable(getattr(obj, "dict")):
        return _to_plain(obj.dict())
    if isinstance(obj, dict):
        return {k: _to_plain(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_to_plain(x) for x in obj]
    return obj

def _extract_json(text: str) -> Dict[str, Any]:
    text2 = re.sub(r"```(?:json)?", "", text, flags=re.IGNORECASE).strip()
    start = text2.find("{")
    end = text2.rfind("}")
    if start == -1 or end == -1 or end < start:
        raise ValueError("no JSON object found")
    return json.loads(text2[start:end+1])

def _make_prompt(transcript: str, active_cards: List[Dict[str, Any]], fluent: Dict[str,Any], learning: Dict[str,Any]) -> str:
    lang_code = learning.get("code", "")[:2] if isinstance(learning, dict) else ""
    language_style = _language_style_instruction(lang_code)

    active_json = json.dumps(active_cards, ensure_ascii=False)
    system = (
        f"You are Coco, a concise language coach. {language_style}\n"
        "Given a possibly-misheard ASR transcript, return a corrected single-sentence utterance in the LEARNING language and a natural translation into the NATIVE language.\n"
        "Detect which active cards (by id) were used. Return ONLY valid JSON exactly matching the schema described below.\n"
    )

    user = (
        "INPUT:\n"
        f"- transcript: {json.dumps(transcript, ensure_ascii=False)}\n"
        f"- fluent_language: {json.dumps(fluent, ensure_ascii=False)}\n"
        f"- learning_language: {json.dumps(learning, ensure_ascii=False)}\n"
        f"- active_cards: {active_json}\n\n"
        "OUTPUT SCHEMA (return exactly one JSON object):\n"
        "{\n"
        '  "corrected_sentence": "...",\n'
        '  "native_translation": "...",\n'
        '  "used_card_ids": ["id1","id2"],\n'
        '  "asr_fixes": [{"original":"...", "guess":"...", "confidence":0.42}],\n'
        '  "brief_explanation_native": "...",\n'
        '  "notes": "",\n'
        '  "audio_chunks": [\n'
        '    {"text":"...","lang":"es-MX","purpose":"corrected_sentence"},\n'
        '    {"text":"...","lang":"en-US","purpose":"native_translation"}\n'
        '  ]\n'
        "}\n\n"
        "Rules:\n"
        "- corrected_sentence must be ONE natural sentence in the learning language (use colloquial Latin-American Spanish for es, casual Indonesian for id).\n"
        "- native_translation must be a natural translation into the fluent/native language.\n"
        "- audio_chunks must include the corrected_sentence chunk first, then the native_translation chunk, each with a proper lang tag (es-MX, id-ID, en-US).\n"
        "- Return only JSON (no commentary, no markdown).\n"
    )
    return system + "\n" + user

def _strip_accents(text: str) -> str:
    """Remove accents/diacritics from text for fuzzy matching."""
    if not text:
        return ""
    # First, handle special Spanish characters explicitly
    text = text.replace('ñ', 'n').replace('Ñ', 'N')
    # Then normalize to NFD (decomposed form) and filter out combining characters
    nfd = unicodedata.normalize('NFD', text)
    return ''.join(char for char in nfd if unicodedata.category(char) != 'Mn')

def _normalize_for_matching(text: str) -> str:
    """Normalize text for matching: strip accents, remove punctuation, lowercase."""
    if not text:
        return ""
    # Strip accents
    text = _strip_accents(text)
    # Remove common punctuation (but keep spaces and letters)
    text = re.sub(r'[.,;:!?¿¡\-_…\.]+', '', text)
    # Normalize whitespace
    text = re.sub(r'\s+', ' ', text)
    return text.strip().lower()

def _init_client():
    if MOCK_MODE:
        return None
    if AZURE_OPENAI_API_KEY and AZURE_OPENAI_BASE_URL and OpenAI is not None:
        return OpenAI(api_key=AZURE_OPENAI_API_KEY, base_url=AZURE_OPENAI_BASE_URL)
    if OPENAI_API_KEY and OpenAI is not None:
        return OpenAI(api_key=OPENAI_API_KEY)
    return None

def _mock_response(transcript: str, active_cards: List[Dict[str,Any]], fluent: Dict[str,Any], learning: Dict[str,Any]) -> Dict[str,Any]:
    # Normalize transcript for matching (strip accents, punctuation, lowercase)
    normalized_transcript = _normalize_for_matching(transcript or "")
    print(f"[MOCK] Normalized transcript: '{normalized_transcript}'")
    used = []
    for c in active_cards:
        val = c.get("value") or c.get("display_text") or ""
        normalized_val = _normalize_for_matching(val)
        if normalized_val:
            is_match = normalized_val in normalized_transcript
            print(f"[MOCK] Card '{c.get('id')}': '{val}' → normalized: '{normalized_val}' → Match: {is_match}")
            if is_match:
                used.append(c.get("id"))
    lang_tag = "es-MX" if learning.get("code","").startswith("es") else ("id-ID" if learning.get("code","").startswith("id") else "en-US")
    return {
        "corrected_sentence": transcript,
        "native_translation": f"(mock) {transcript}",
        "used_card_ids": used,
        "asr_fixes": [],
        "brief_explanation_native": "(mock) small wording adjustments.",
        "notes": "",
        "audio_chunks": [
            {"text": transcript, "lang": lang_tag, "purpose": "corrected_sentence"},
            {"text": f"(mock) {transcript}", "lang": "en-US", "purpose": "native_translation"},
        ],
    }

def call_llm_for_turn(
    transcript: str,
    active_cards: List[Any],
    fluent: Any,
    learning: Any,
    wispr_alternatives: Optional[List[Any]] = None,
    model: Optional[str] = None,
    temperature: float = 0.15,
    timeout: int = 30,
) -> Dict[str,Any]:
    model = model or DEFAULT_MODEL
    active_plain = _to_plain(active_cards or [])
    fluent_plain = _to_plain(fluent or {})
    learning_plain = _to_plain(learning or {})

    prompt = _make_prompt(transcript, active_plain, fluent_plain, learning_plain)
    client = _init_client()
    if client is None:
        return _mock_response(transcript, active_plain, fluent_plain, learning_plain)

    try:
        resp = client.responses.create(
            model=model,
            input=prompt,
            temperature=temperature,
            max_output_tokens=600,
            timeout=timeout,
        )

        # extract text robustly
        raw_text = ""
        if hasattr(resp, "output_text") and resp.output_text:
            raw_text = resp.output_text
        else:
            out = getattr(resp, "output", None) or resp.get("output", None)
            if out:
                parts = []
                for item in out:
                    if isinstance(item, dict):
                        content = item.get("content") or []
                        if isinstance(content, list):
                            for c in content:
                                if isinstance(c, dict):
                                    txt = c.get("text") or ""
                                    if txt:
                                        parts.append(txt)
                                elif isinstance(c, str):
                                    parts.append(c)
                        elif isinstance(content, str):
                            parts.append(content)
                    elif isinstance(item, str):
                        parts.append(item)
                raw_text = "\n".join(parts)
            else:
                raw_text = str(resp)

        parsed = _extract_json(raw_text)
        # ensure keys exist
        parsed.setdefault("corrected_sentence", "")
        parsed.setdefault("native_translation", "")
        parsed.setdefault("used_card_ids", [])
        parsed.setdefault("asr_fixes", [])
        parsed.setdefault("brief_explanation_native", "")
        parsed.setdefault("notes", "")
        parsed.setdefault("audio_chunks", [])
        return parsed

    except Exception as e:
        print("LLM call failed:", e)
        return _mock_response(transcript, active_plain, fluent_plain, learning_plain)


def check_trivia_answer(
    user_answer: str,
    correct_answer: str,
    english_prompt: str,
    fluent: Dict[str, Any],
    learning: Dict[str, Any],
    model: Optional[str] = None,
    temperature: float = 0.15,
    timeout: int = 20,
) -> Dict[str, Any]:
    """
    Check if user's answer is semantically equivalent to correct answer.

    Returns:
    {
        "is_correct": bool,
        "feedback": str,  # In fluent/native language
        "corrected_answer": str,  # Corrected version of user's answer
    }
    """
    model = model or DEFAULT_MODEL
    client = _init_client()

    if client is None:
        # Mock mode - simple string comparison
        normalized_user = _normalize_for_matching(user_answer)
        normalized_correct = _normalize_for_matching(correct_answer)
        is_correct = normalized_user == normalized_correct

        return {
            "is_correct": is_correct,
            "feedback": "(mock) Correct!" if is_correct else "(mock) Not quite right. Try again!",
            "corrected_answer": correct_answer,
        }

    lang_code = learning.get("code", "")[:2]
    language_style = _language_style_instruction(lang_code)

    fluent_name = fluent.get("name", "English")
    learning_name = learning.get("name", "Spanish")

    system_prompt = (
        f"You are a language learning assistant. {language_style}\n"
        f"Your task is to determine if a student's {learning_name} answer is semantically equivalent to the correct answer.\n"
        "Be lenient with minor grammar mistakes, but check that the core meaning matches.\n"
        "Return only valid JSON."
    )

    user_prompt = (
        "INPUT:\n"
        f"- {fluent_name} prompt: {json.dumps(english_prompt, ensure_ascii=False)}\n"
        f"- Correct {learning_name} answer: {json.dumps(correct_answer, ensure_ascii=False)}\n"
        f"- User's {learning_name} answer: {json.dumps(user_answer, ensure_ascii=False)}\n\n"
        "OUTPUT SCHEMA (return exactly one JSON object):\n"
        "{\n"
        '  "is_correct": true/false,\n'
        f'  "feedback": "...",  # Brief feedback in {fluent_name}\n'
        '  "corrected_answer": "..."  # Corrected version of user answer if needed\n'
        "}\n\n"
        "Rules:\n"
        "- is_correct should be true if the user's answer conveys the same meaning as the correct answer.\n"
        "- Minor grammar or spelling mistakes are acceptable if meaning is clear.\n"
        f"- feedback should be encouraging and in {fluent_name}.\n"
        "- corrected_answer should be the user's answer with corrections applied.\n"
    )

    full_prompt = system_prompt + "\n\n" + user_prompt

    try:
        resp = client.responses.create(
            model=model,
            input=full_prompt,
            temperature=temperature,
            max_output_tokens=300,
            timeout=timeout,
        )

        # Extract text (reuse existing pattern from call_llm_for_turn)
        raw_text = ""
        if hasattr(resp, "output_text") and resp.output_text:
            raw_text = resp.output_text
        elif hasattr(resp, "choices") and resp.choices:
            c = resp.choices[0]
            if hasattr(c, "message") and hasattr(c.message, "content"):
                raw_text = c.message.content or ""
            elif hasattr(c, "text"):
                raw_text = c.text or ""
        elif hasattr(resp, "content"):
            if isinstance(resp.content, list):
                for block in resp.content:
                    if hasattr(block, "text"):
                        raw_text += block.text
            else:
                raw_text = str(resp.content)

        parsed = _extract_json(raw_text)
        parsed.setdefault("is_correct", False)
        parsed.setdefault("feedback", "")
        parsed.setdefault("corrected_answer", correct_answer)

        return parsed
    except Exception as e:
        print("LLM trivia check failed:", e)
        import traceback
        traceback.print_exc()
        # Fallback to mock
        normalized_user = _normalize_for_matching(user_answer)
        normalized_correct = _normalize_for_matching(correct_answer)
        is_correct = normalized_user == normalized_correct

        return {
            "is_correct": is_correct,
            "feedback": "Correct!" if is_correct else "Not quite right. Try again!",
            "corrected_answer": correct_answer,
        }
