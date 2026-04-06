# llm_call.py
import os
import json
import re
import unicodedata
import difflib
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
DEBUG = os.getenv("DEBUG", "0") == "1"

def _log_debug(title: str, content: str, max_length: int = 2000):
    """Log debug information if DEBUG mode is enabled."""
    if not DEBUG:
        return

    separator = "=" * 80
    print(f"\n{separator}")
    print(f"🔍 DEBUG: {title}")
    print(separator)

    if len(content) > max_length:
        print(content[:max_length])
        print(f"\n... (truncated, {len(content) - max_length} more characters)")
        print(f"\n💡 Full content length: {len(content)} characters")
    else:
        print(content)

    print(separator + "\n")

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
    # Remove ALL non-alphanumeric characters (punctuation, quotes, symbols)
    text = re.sub(r'[^a-zA-Z0-9\s]', '', text)
    # Normalize whitespace
    text = re.sub(r'\s+', ' ', text)
    return text.strip().lower()

def _diff_tokens(original: str, corrected: str) -> List[Dict[str, str]]:
    """Compute a word-level diff between original and corrected using difflib."""
    # Split into words, preserving spaces by attaching trailing space to each token
    def tokenize(text: str) -> List[str]:
        words = re.split(r'(\s+)', text)
        # Merge word with following whitespace so spacing is preserved
        tokens = []
        i = 0
        while i < len(words):
            if words[i] == '':
                i += 1
                continue
            if i + 1 < len(words) and re.match(r'\s+', words[i + 1]):
                tokens.append(words[i] + words[i + 1])
                i += 2
            else:
                tokens.append(words[i])
                i += 1
        return tokens

    orig_tokens = tokenize(original)
    corr_tokens = tokenize(corrected)

    matcher = difflib.SequenceMatcher(None, orig_tokens, corr_tokens, autojunk=False)
    result = []
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            for t in orig_tokens[i1:i2]:
                result.append({"text": t, "status": "ok"})
        elif tag == "replace":
            for t in orig_tokens[i1:i2]:
                result.append({"text": t, "status": "remove"})
            for t in corr_tokens[j1:j2]:
                result.append({"text": t, "status": "add"})
        elif tag == "delete":
            for t in orig_tokens[i1:i2]:
                result.append({"text": t, "status": "remove"})
        elif tag == "insert":
            for t in corr_tokens[j1:j2]:
                result.append({"text": t, "status": "add"})

    # Ensure a visible space between remove and add groups so they don't run together
    spaced = []
    for i, tok in enumerate(result):
        spaced.append(tok)
        if tok["status"] == "remove" and i + 1 < len(result) and result[i + 1]["status"] == "add":
            if not tok["text"].endswith(" "):
                spaced.append({"text": " ", "status": "ok"})
    return spaced


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
    _log_debug("STORY CARDS GAME - LLM REQUEST", prompt)

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
        _log_debug("STORY CARDS GAME - LLM RESPONSE (parsed)", json.dumps(parsed, indent=2, ensure_ascii=False))

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
    accepted_translations: Optional[List[str]] = None,
    model: Optional[str] = None,
    temperature: float = 0.15,
    timeout: int = 20,
) -> Dict[str, Any]:
    """
    Check if user's answer is semantically equivalent to the correct answer.

    Returns:
    {
        "accepted": bool,
        "damage_multiplier": float,  # 1.0 = perfect, 0.0 = wrong
        "feedback_key": str | None,  # snake_case grammar issue code
        "corrected_snippet": str | None,  # minimal corrected phrase
    }
    """
    # --- Normalization fast-path ---
    candidates = accepted_translations if accepted_translations else [correct_answer]
    norm_user = _normalize_for_matching(user_answer)
    for candidate in candidates:
        if _normalize_for_matching(candidate) == norm_user:
            return {
                "accepted": True,
                "damage_multiplier": 1.0,
                "feedback_key": None,
                "corrected_snippet": None,
                "fast_path": True,
            }

    model = model or DEFAULT_MODEL
    client = _init_client()

    if client is None:
        # Mock mode
        is_correct = norm_user == _normalize_for_matching(correct_answer)
        return {
            "accepted": is_correct,
            "damage_multiplier": 1.0 if is_correct else 0.0,
            "feedback_key": None,
            "corrected_snippet": None,
        }

    lang_code = learning.get("code", "")[:2]
    language_style = _language_style_instruction(lang_code)
    learning_name = learning.get("name", "Spanish")

    system_prompt = (
        f"You are a strict but fair {learning_name} language learning judge. {language_style}\n"
        "Evaluate the student's answer against the reference answer.\n\n"
        "Rules:\n"
        "- NEVER penalize for missing accents, punctuation, or capitalization.\n"
        "- FIRST, before any other evaluation: the student is using speech-to-text (Wispr). Check if unexpected words are STT mishearings. Common patterns: phonetically similar words (e.g. 'cus'→'jus'), merged or split tokens (e.g. 'Este'→'Es teh', 'S T'→'es teh', 'dise'→'di sini'), or words run together. If correcting the mishearing makes the answer acceptable, IMMEDIATELY set accepted: true, damage_multiplier: 1.0, feedback_key: 'asr_error', and explain in feedback_explanation. Do NOT apply any other feedback_key in this case.\n"
        "- accepted: true if the student demonstrated understanding of the meaning, even if imperfectly expressed. ONLY set accepted: false for wrong conjugation, wrong tense that changes meaning, or completely wrong/missing core meaning.\n"
        "- damage_multiplier:\n"
        "    1.0   → feedback_key: perfect — answer is natural, idiomatic, and fully correct; nothing to correct\n"
        "    1.0   → feedback_key: asr_error — likely STT mishearing, otherwise acceptable\n"
        "    0.85  → missing_minor_words: dropped a particle, softener, or minor word (e.g. 'saja', 'ya', 'que')\n"
        "    0.8   → gender_agreement: wrong gender on article/adjective | register_too_formal: too formal for context (e.g. -kah suffix) | register_too_informal: too casual for context (e.g. 'aja' instead of 'saja')\n"
        "    0.75  → subtle_meaning_shift: slightly different nuance but meaning mostly intact | wrong_mood: used indicative instead of subjunctive/conditional, but meaning clear\n"
        "    0.7   → word_order: words rearranged, meaning still understandable\n"
        "    0.6   → unnatural_phrasing: valid grammar but a native speaker would immediately notice\n"
        "    0.0   → wrong_conjugation | wrong_tense | wrong_meaning; accepted must be false\n"
        "- feedback_key: REQUIRED — always set one of:\n"
        "    perfect | asr_error | missing_minor_words | gender_agreement | register_too_formal | register_too_informal | subtle_meaning_shift | wrong_mood | word_order | unnatural_phrasing | wrong_conjugation | wrong_tense | wrong_meaning\n"
        "  Use perfect ONLY when the answer is truly natural, idiomatic, and correct with absolutely nothing to improve — a native speaker would say exactly this. Do NOT use perfect if there is even a minor note.\n"
        "  Use asr_error when the answer appears correct except for a likely STT mishearing.\n"
        "  Use wrong_mood for subjunctive/conditional/imperative mix-ups — always accepted with 0.75 multiplier.\n"
        "  Use register_too_formal when too formal for context. Use register_too_informal when too casual.\n"
        "- corrected_snippet: the minimal corrected word or phrase to replace what the student wrote — NOT the student's original word. null if feedback_key is perfect or asr_error.\n"
        f"- feedback_explanation: when feedback_key is set (and NOT perfect or asr_error), write ONE to TWO sentences in {fluent.get('name', 'English')} structured as: 'You said X, but Y is more natural/correct because Z.' Always name what the student wrote first, then the correct form, then explain why. NEVER describe the student's incorrect form as natural or correct. For asr_error: explain what was likely misheard. null if feedback_key is perfect.\n"
        "- corrected_full_answer: when feedback_key is set (and NOT perfect or asr_error), write the student's full answer with ONLY the mistake(s) fixed — keep everything else word-for-word identical to what the student wrote. null if feedback_key is perfect or asr_error.\n"
        "Return ONLY valid JSON, no prose."
    )

    # Remove hyphens joining word parts (e.g. "menu-nya" → "menunya") before LLM sees the answer
    user_answer = re.sub(r'(?<=\w)-(?=\w)', '', user_answer)

    all_candidates = accepted_translations if accepted_translations else [correct_answer]
    if len(all_candidates) > 1:
        refs_str = "\n".join(f"  - {json.dumps(c, ensure_ascii=False)}" for c in all_candidates)
        ref_line = f"Accepted answers (any of these is correct):\n{refs_str}"
    else:
        ref_line = f"Reference answer: {json.dumps(all_candidates[0], ensure_ascii=False)}"

    user_prompt = (
        f"Prompt ({learning.get('name','Spanish')}): {json.dumps(english_prompt, ensure_ascii=False)}\n"
        f"{ref_line}\n"
        f"Student's answer: {json.dumps(user_answer, ensure_ascii=False)}\n\n"
        'Return: {"accepted": bool, "damage_multiplier": float, "feedback_key": string|null, "corrected_snippet": string|null, "feedback_explanation": string|null, "corrected_full_answer": string|null}'
    )

    full_prompt = system_prompt + "\n\n" + user_prompt
    _log_debug("BATTLE CHECK - LLM REQUEST", full_prompt)

    try:
        resp = client.responses.create(
            model=model,
            input=full_prompt,
            temperature=temperature,
            max_output_tokens=600,
            timeout=timeout,
        )

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
        _log_debug("BATTLE CHECK - LLM RESPONSE", json.dumps(parsed, indent=2, ensure_ascii=False))

        parsed.setdefault("accepted", False)
        parsed.setdefault("damage_multiplier", 0.0)
        parsed.setdefault("feedback_key", None)
        parsed.setdefault("corrected_snippet", None)
        parsed.setdefault("feedback_explanation", None)
        parsed.setdefault("corrected_full_answer", None)

        # Compute correction_tokens algorithmically from user_answer vs corrected_full_answer
        corrected_full = parsed.get("corrected_full_answer")
        fk = parsed.get("feedback_key")
        if corrected_full and fk and fk != "asr_error" and user_answer:
            parsed["correction_tokens"] = _diff_tokens(user_answer, corrected_full)
        else:
            parsed["correction_tokens"] = None

        # Enforce consistency: these keys must always result in accepted: true
        # (LLM sometimes ignores the prompt instruction)
        ALWAYS_ACCEPT_MULTIPLIERS = {
            "perfect": 1.0,
            "asr_error": 1.0,
            "missing_minor_words": 0.85,
            "gender_agreement": 0.8,
            "register_too_formal": 0.8,
            "register_too_informal": 0.8,
            "subtle_meaning_shift": 0.75,
            "wrong_mood": 0.75,
            "word_order": 0.7,
            "unnatural_phrasing": 0.6,
        }
        fk = parsed["feedback_key"]
        if not parsed["accepted"] and fk in ALWAYS_ACCEPT_MULTIPLIERS:
            parsed["accepted"] = True
            if parsed["damage_multiplier"] == 0.0:
                parsed["damage_multiplier"] = ALWAYS_ACCEPT_MULTIPLIERS[fk]

        # Extract token usage
        prompt_tokens = 0
        completion_tokens = 0
        total_tokens = 0
        if hasattr(resp, "usage") and resp.usage:
            usage = resp.usage
            prompt_tokens = getattr(usage, "input_tokens", 0) or getattr(usage, "prompt_tokens", 0) or 0
            completion_tokens = getattr(usage, "output_tokens", 0) or getattr(usage, "completion_tokens", 0) or 0
            total_tokens = getattr(usage, "total_tokens", 0) or (prompt_tokens + completion_tokens)
        input_cost_per_token = 0.00000015
        output_cost_per_token = 0.00000060
        cost_cents = round(((prompt_tokens * input_cost_per_token) + (completion_tokens * output_cost_per_token)) * 100, 4)
        parsed["token_usage"] = {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": total_tokens,
            "cost_cents": cost_cents,
        }

        return parsed
    except Exception as e:
        print("LLM battle check failed:", e)
        import traceback
        traceback.print_exc()
        norm_correct = _normalize_for_matching(correct_answer)
        is_correct = norm_user == norm_correct
        return {
            "accepted": is_correct,
            "damage_multiplier": 1.0 if is_correct else 0.0,
            "feedback_key": None,
            "corrected_snippet": None,
        }


def call_llm_for_messenger(
    system_prompt: str,
    user_message: str,
    model: Optional[str] = None,
    temperature: float = 0.2,
    timeout: int = 30,
) -> Dict[str, Any]:
    """
    Call LLM for messenger chat with structured output.

    Returns:
    {
        "corrected_input": str,
        "had_errors": bool,
        "error_explanation": str,
        "response_chunks": [...],
        "level_assessment": {...},
        "token_usage": {
            "prompt_tokens": int,
            "completion_tokens": int,
            "total_tokens": int,
            "cost_cents": float
        }
    }
    """
    model = model or DEFAULT_MODEL
    client = _init_client()

    if client is None:
        # Mock mode - return realistic sample response
        return {
            "corrected_input": "Hola, ¿cómo estás?",
            "had_errors": False,
            "error_explanation": "",
            "response_chunks": [
                {
                    "text": "Hi! How's it going?",
                    "language": "ui",
                    "modality": "text",
                    "purpose": "greeting"
                },
                {
                    "text": "¿Qué tal tu día?",
                    "language": "target",
                    "modality": "audio",
                    "locale": "es-MX",
                    "purpose": "question"
                },
                {
                    "text": "How's your day going?",
                    "language": "ui",
                    "modality": "text",
                    "purpose": "translation_help"
                }
            ],
            "level_assessment": {
                "current_level": "beginner",
                "confidence": 0.6,
                "should_update": False,
                "reasoning": "Mock mode - no real assessment",
                "add_comfortable": [],
                "add_weak": [],
                "remove_weak": []
            },
            "token_usage": {
                "prompt_tokens": 150,
                "completion_tokens": 80,
                "total_tokens": 230,
                "cost_cents": 0.0705  # Mock: simulated cost
            }
        }

    # Real LLM call
    full_prompt = system_prompt + "\n\n" + user_message
    _log_debug("MESSENGER CHAT - LLM REQUEST", full_prompt, max_length=3000)

    try:
        resp = client.responses.create(
            model=model,
            input=full_prompt,
            temperature=temperature,
            max_output_tokens=800,
            timeout=timeout,
        )

        # Extract token usage from response
        prompt_tokens = 0
        completion_tokens = 0
        total_tokens = 0

        # Debug: print response attributes to understand structure
        print(f"[DEBUG] Response type: {type(resp)}")
        print(f"[DEBUG] Response attributes: {[a for a in dir(resp) if not a.startswith('_')]}")

        # Try to get usage from response object - multiple approaches
        # Approach 1: resp.usage object (Chat Completions API style)
        if hasattr(resp, "usage") and resp.usage:
            usage = resp.usage
            print(f"[DEBUG] Usage object found: {usage}")
            prompt_tokens = getattr(usage, "input_tokens", 0) or getattr(usage, "prompt_tokens", 0) or 0
            completion_tokens = getattr(usage, "output_tokens", 0) or getattr(usage, "completion_tokens", 0) or 0
            total_tokens = getattr(usage, "total_tokens", 0) or (prompt_tokens + completion_tokens)

        # Approach 2: Direct attributes on response (Responses API style)
        if total_tokens == 0 and hasattr(resp, "input_tokens"):
            prompt_tokens = resp.input_tokens or 0
            completion_tokens = getattr(resp, "output_tokens", 0) or 0
            total_tokens = prompt_tokens + completion_tokens
            print(f"[DEBUG] Direct tokens: in={prompt_tokens}, out={completion_tokens}")

        # Approach 3: Try to access as dict
        if total_tokens == 0:
            try:
                resp_dict = resp.model_dump() if hasattr(resp, "model_dump") else (resp.dict() if hasattr(resp, "dict") else None)
                if resp_dict:
                    print(f"[DEBUG] Response dict keys: {resp_dict.keys()}")
                    if "usage" in resp_dict:
                        usage_dict = resp_dict["usage"]
                        prompt_tokens = usage_dict.get("input_tokens", 0) or usage_dict.get("prompt_tokens", 0) or 0
                        completion_tokens = usage_dict.get("output_tokens", 0) or usage_dict.get("completion_tokens", 0) or 0
                        total_tokens = usage_dict.get("total_tokens", 0) or (prompt_tokens + completion_tokens)
                        print(f"[DEBUG] Dict usage: {usage_dict}")
            except Exception as e:
                print(f"[DEBUG] Dict extraction failed: {e}")

        # Calculate cost in cents
        # Pricing for gpt-4o-mini: $0.15/1M input, $0.60/1M output
        # For gpt-4.1-mini, using similar pricing
        input_cost_per_token = 0.00000015  # $0.15 / 1,000,000
        output_cost_per_token = 0.00000060  # $0.60 / 1,000,000
        cost_dollars = (prompt_tokens * input_cost_per_token) + (completion_tokens * output_cost_per_token)
        cost_cents = cost_dollars * 100  # Convert to cents

        _log_debug("TOKEN USAGE", f"Prompt: {prompt_tokens}, Completion: {completion_tokens}, Total: {total_tokens}, Cost: {cost_cents:.4f} cents")

        # Extract text robustly
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
        _log_debug("MESSENGER CHAT - LLM RESPONSE (parsed)", json.dumps(parsed, indent=2, ensure_ascii=False))

        # Ensure all required keys exist
        parsed.setdefault("corrected_input", "")
        parsed.setdefault("had_errors", False)
        parsed.setdefault("error_explanation", "")
        parsed.setdefault("response_chunks", [])
        parsed.setdefault("quiz_candidates", [])
        parsed.setdefault("level_assessment", {
            "current_level": "beginner",
            "confidence": 0.5,
            "should_update": False,
            "reasoning": "",
            "add_comfortable": [],
            "add_weak": [],
            "remove_weak": []
        })

        # Add token usage info
        parsed["token_usage"] = {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": total_tokens,
            "cost_cents": round(cost_cents, 4)
        }

        return parsed

    except Exception as e:
        print("LLM messenger call failed:", e)
        import traceback
        traceback.print_exc()

        # Fallback to mock response
        return {
            "corrected_input": "Error occurred",
            "had_errors": False,
            "error_explanation": "",
            "response_chunks": [
                {
                    "text": "Sorry, I'm having trouble understanding right now. Could you try again?",
                    "language": "ui",
                    "modality": "text",
                    "purpose": "error"
                }
            ],
            "level_assessment": {
                "current_level": "beginner",
                "confidence": 0.5,
                "should_update": False,
                "reasoning": "Error fallback",
                "add_comfortable": [],
                "add_weak": [],
                "remove_weak": []
            },
            "token_usage": {
                "prompt_tokens": 0,
                "completion_tokens": 0,
                "total_tokens": 0,
                "cost_cents": 0.0
            }
        }


def call_llm_to_pick_secret(
    theme: str,
    model: Optional[str] = None,
    temperature: float = 1.0,
    timeout: int = 20,
) -> str:
    """
    Ask LLM to pick a random secret answer from the given theme.

    Args:
        theme: Theme name like "animals", "mythical", etc.

    Returns:
        The secret answer (e.g., "elephant")
    """
    model = model or DEFAULT_MODEL
    client = _init_client()

    if client is None:
        # Mock mode - return simple answer
        if theme == "animals":
            return "elephant"
        elif theme == "mythical":
            return "dragon"
        return "unknown"

    system_prompt = (
        "You are a helpful assistant for a guessing game. "
        "Pick a random item from the specified theme that would make a good guessing game challenge."
    )

    user_prompt = (
        f"Pick one random item from the theme: '{theme}'\n"
        "Return ONLY the item name in lowercase English (e.g., 'elephant', 'dragon').\n"
        "No explanation, no punctuation, just the name."
    )

    full_prompt = system_prompt + "\n\n" + user_prompt
    _log_debug("GUESSING GAME - PICK SECRET REQUEST", full_prompt)

    try:
        resp = client.responses.create(
            model=model,
            input=full_prompt,
            temperature=temperature,
            max_output_tokens=50,
            timeout=timeout,
        )

        # Extract text
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

        # Clean up the response
        secret = raw_text.strip().lower()
        # Remove common punctuation
        secret = re.sub(r'[.,;:!?\-_…\.\"\']', '', secret)
        secret = secret.strip()

        _log_debug("GUESSING GAME - PICK SECRET RESPONSE", f"Secret chosen: {secret}")

        return secret

    except Exception as e:
        print("LLM pick secret failed:", e)
        import traceback
        traceback.print_exc()
        # Fallback
        return "elephant" if theme == "animals" else "dragon"


def call_llm_for_guessing_turn(
    user_input: str,
    secret: str,
    theme: str,
    history: List[Dict[str, str]],
    model: Optional[str] = None,
    temperature: float = 0.3,
    timeout: int = 20,
) -> Dict[str, Any]:
    """
    Process user's question or guess in the guessing game.

    Args:
        user_input: User's question or guess
        secret: The secret answer
        theme: Theme name
        history: Previous question/answer pairs

    Returns:
    {
        "response": str,  # Yes/no answer or congratulations
        "is_correct_guess": bool
    }
    """
    model = model or DEFAULT_MODEL
    client = _init_client()

    # Check if user is directly guessing
    normalized_input = _normalize_for_matching(user_input)
    normalized_secret = _normalize_for_matching(secret)

    is_direct_guess = (
        normalized_secret in normalized_input or
        normalized_input in normalized_secret
    )

    if client is None:
        # Mock mode
        if is_direct_guess:
            return {
                "corrected_input": user_input,
                "had_errors": False,
                "error_explanation": "",
                "response": f"🎉 Yes! You got it! The answer was {secret}!",
                "is_correct_guess": True
            }
        else:
            return {
                "corrected_input": user_input,
                "had_errors": False,
                "error_explanation": "",
                "response": "Yes! / No! (mock mode)",
                "is_correct_guess": False
            }

    # Build conversation history
    history_str = ""
    if history:
        history_lines = []
        for turn in history[-5:]:  # Last 5 turns
            history_lines.append(f"User: {turn['user']}")
            history_lines.append(f"You: {turn['response']}")
        history_str = "CONVERSATION HISTORY:\n" + "\n".join(history_lines)

    system_prompt = (
        f"You are playing a guessing game. You have picked: {secret}\n"
        f"Theme: {theme}\n\n"
        "The user will ask yes/no questions to try to guess what you picked.\n"
        "Answer their questions honestly with 'Yes' or 'No' (you can add brief clarifications).\n"
        "If they directly guess the correct answer, respond with excitement and confirm they got it right.\n"
        "Be friendly and encouraging."
    )

    user_prompt = (
        f"{history_str}\n\n"
        f"USER'S CURRENT INPUT: {user_input}\n\n"
        "OUTPUT SCHEMA (return exactly one JSON object):\n"
        "{\n"
        '  "corrected_input": "...",  # Corrected version of user input (if any errors)\n'
        '  "had_errors": true/false,\n'
        '  "error_explanation": "...",  # Brief explanation of corrections in English\n'
        '  "response": "...",  # Your yes/no answer or congratulations\n'
        '  "is_correct_guess": true/false\n'
        "}\n\n"
        "Rules:\n"
        "- First, correct any grammar/spelling errors in the user's input. If no errors, corrected_input = user_input.\n"
        "- If there are errors, set had_errors=true and provide a brief explanation in English.\n"
        "- Then answer their question: if asking a yes/no question, answer honestly based on whether it applies to your secret.\n"
        "- If the user is directly guessing your secret, set is_correct_guess=true and give an excited response.\n"
        "- Keep responses brief and natural.\n"
        "- Return only JSON."
    )

    full_prompt = system_prompt + "\n\n" + user_prompt
    _log_debug("GUESSING GAME - TURN REQUEST", full_prompt, max_length=1500)

    try:
        resp = client.responses.create(
            model=model,
            input=full_prompt,
            temperature=temperature,
            max_output_tokens=150,
            timeout=timeout,
        )

        # Extract text
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
        parsed.setdefault("corrected_input", user_input)
        parsed.setdefault("had_errors", False)
        parsed.setdefault("error_explanation", "")
        parsed.setdefault("response", "")
        parsed.setdefault("is_correct_guess", False)

        # Double-check with our own normalization
        if is_direct_guess and not parsed["is_correct_guess"]:
            parsed["is_correct_guess"] = True
            parsed["response"] = f"🎉 Yes! You got it! The answer was {secret}!"

        _log_debug("GUESSING GAME - TURN RESPONSE (parsed)", json.dumps(parsed, indent=2, ensure_ascii=False))

        return parsed

    except Exception as e:
        print("LLM guessing turn failed:", e)
        import traceback
        traceback.print_exc()

        # Fallback
        if is_direct_guess:
            return {
                "corrected_input": user_input,
                "had_errors": False,
                "error_explanation": "",
                "response": f"🎉 Yes! You got it! The answer was {secret}!",
                "is_correct_guess": True
            }
        else:
            return {
                "corrected_input": user_input,
                "had_errors": False,
                "error_explanation": "",
                "response": "Hmm, I'm not sure. Can you rephrase your question?",
                "is_correct_guess": False
            }
