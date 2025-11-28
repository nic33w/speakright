# llm_call.py
import os
import json
import re
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

def _init_client():
    if MOCK_MODE:
        return None
    if AZURE_OPENAI_API_KEY and AZURE_OPENAI_BASE_URL and OpenAI is not None:
        return OpenAI(api_key=AZURE_OPENAI_API_KEY, base_url=AZURE_OPENAI_BASE_URL)
    if OPENAI_API_KEY and OpenAI is not None:
        return OpenAI(api_key=OPENAI_API_KEY)
    return None

def _mock_response(transcript: str, active_cards: List[Dict[str,Any]], fluent: Dict[str,Any], learning: Dict[str,Any]) -> Dict[str,Any]:
    lower = (transcript or "").lower()
    used = []
    for c in active_cards:
        val = (c.get("value") or c.get("display_text") or "").lower()
        if val and val in lower:
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
