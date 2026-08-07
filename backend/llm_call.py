# llm_call.py
import json
import re
import unicodedata
import difflib
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Union

from settings import (
    AZURE_OPENAI_API_KEY,
    AZURE_OPENAI_BASE_URL,
    DEBUG,
    DEFAULT_MODEL,
    DEFAULT_PRICING,
    MOCK_MODE,
    MODEL_PRICING,
    OPENAI_API_KEY,
    SCENE_MODEL,
    TRANSLATE_MODEL,
    locale_for,
)

try:
    # modern OpenAI client
    from openai import OpenAI
except Exception:
    OpenAI = None

try:
    from usage_tracker import add_openai_cost as _add_openai_cost
except Exception:
    _add_openai_cost = None

def _log_debug(title: str, content: str, max_length: int = 2000):
    """Log debug information if DEBUG mode is enabled."""
    if not DEBUG:
        return

    separator = "=" * 80
    print(f"\n{separator}")
    # ASCII only: emoji here crashes on cp1252 consoles/pipes on Windows
    print(f"DEBUG: {title}")
    print(separator)

    if len(content) > max_length:
        print(content[:max_length])
        print(f"\n... (truncated, {len(content) - max_length} more characters)")
        print(f"\n💡 Full content length: {len(content)} characters")
    else:
        print(content)

    print(separator + "\n")

from prompt_fragments import (
    NEVER_PENALIZE_ACCENTS_RULE,
    STORY_CARDS_RULES,
    STT_TOLERANCE_RULE,
    UNNATURAL_PHRASING_RULE,
    language_style_instruction as _language_style_instruction,
)

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
        + STORY_CARDS_RULES
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

def _normalize_for_llm(text: str) -> str:
    """Strip accents, punctuation, and lowercase text before sending to LLM, so the LLM
    cannot flag accent, punctuation, or capitalization differences as errors."""
    if not text:
        return ""
    text = _strip_accents(text)
    # Remove punctuation/symbols but keep letters, digits, spaces
    text = re.sub(r'[^\w\s]', ' ', text)
    text = re.sub(r'\s+', ' ', text)
    return text.strip().lower()

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

    def compare_key(tok: str) -> str:
        """Strip accents and punctuation for comparison, keeping the display text intact."""
        return _normalize_for_llm(tok).lower()

    orig_tokens = tokenize(original)
    corr_tokens = tokenize(corrected)

    # Use normalized forms for diffing so punctuation/accent differences don't show as errors
    orig_keys = [compare_key(t) for t in orig_tokens]
    corr_keys = [compare_key(t) for t in corr_tokens]

    matcher = difflib.SequenceMatcher(None, orig_keys, corr_keys, autojunk=False)
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


# --- Shared OpenAI call helper ---

@dataclass
class LLMCallResult:
    parsed: Optional[Dict[str, Any]]  # None when parse_json=False
    raw_text: str
    token_usage: Dict[str, Any]  # prompt_tokens, completion_tokens, total_tokens, cost_cents


def _extract_response_text(resp) -> str:
    """Extract text from an OpenAI response object — superset of the per-function
    variants this replaced: Responses API output_text / output-list walk, plus
    Chat-Completions-style .choices / .content fallbacks."""
    if hasattr(resp, "output_text") and resp.output_text:
        return resp.output_text

    out = getattr(resp, "output", None)
    if out is None and isinstance(resp, dict):
        out = resp.get("output")
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
        return "\n".join(parts)

    if hasattr(resp, "choices") and resp.choices:
        c = resp.choices[0]
        if hasattr(c, "message") and hasattr(c.message, "content"):
            return c.message.content or ""
        if hasattr(c, "text"):
            return c.text or ""

    if hasattr(resp, "content"):
        if isinstance(resp.content, list):
            return "".join(block.text for block in resp.content if hasattr(block, "text"))
        return str(resp.content)

    return str(resp)


def _extract_token_counts(resp) -> tuple:
    """Extract (prompt_tokens, completion_tokens, total_tokens) from a response,
    trying usage object, direct attributes, then model_dump."""
    prompt_tokens = 0
    completion_tokens = 0
    total_tokens = 0

    if hasattr(resp, "usage") and resp.usage:
        usage = resp.usage
        prompt_tokens = getattr(usage, "input_tokens", 0) or getattr(usage, "prompt_tokens", 0) or 0
        completion_tokens = getattr(usage, "output_tokens", 0) or getattr(usage, "completion_tokens", 0) or 0
        total_tokens = getattr(usage, "total_tokens", 0) or (prompt_tokens + completion_tokens)

    if total_tokens == 0 and hasattr(resp, "input_tokens"):
        prompt_tokens = resp.input_tokens or 0
        completion_tokens = getattr(resp, "output_tokens", 0) or 0
        total_tokens = prompt_tokens + completion_tokens

    if total_tokens == 0:
        try:
            resp_dict = resp.model_dump() if hasattr(resp, "model_dump") else (resp.dict() if hasattr(resp, "dict") else None)
            if resp_dict and "usage" in resp_dict:
                usage_dict = resp_dict["usage"]
                prompt_tokens = usage_dict.get("input_tokens", 0) or usage_dict.get("prompt_tokens", 0) or 0
                completion_tokens = usage_dict.get("output_tokens", 0) or usage_dict.get("completion_tokens", 0) or 0
                total_tokens = usage_dict.get("total_tokens", 0) or (prompt_tokens + completion_tokens)
        except Exception as e:
            _log_debug("TOKEN USAGE", f"model_dump extraction failed: {e}")

    return prompt_tokens, completion_tokens, total_tokens


def _call_openai_json(
    prompt: Union[str, List[Dict[str, str]]],
    *,
    label: str,
    model: Optional[str] = None,
    temperature: float = 0.2,
    max_output_tokens: int = 600,
    timeout: int = 30,
    parse_json: bool = True,
    record_cost: bool = True,
) -> LLMCallResult:
    """One OpenAI responses.create call: text extraction, optional JSON parse,
    token/cost accounting against settings.MODEL_PRICING, and usage-tracker
    recording. Raises on API/parse errors — each caller keeps its own fallback.
    Callers short-circuit to their mocks BEFORE calling this (MOCK_MODE)."""
    model = model or DEFAULT_MODEL
    client = _init_client()
    if client is None:
        raise RuntimeError("LLM client unavailable (mock mode or missing API key)")

    resp = client.responses.create(
        model=model,
        input=prompt,
        temperature=temperature,
        max_output_tokens=max_output_tokens,
        timeout=timeout,
    )

    prompt_tokens, completion_tokens, total_tokens = _extract_token_counts(resp)
    input_rate, output_rate = MODEL_PRICING.get(model, DEFAULT_PRICING)
    cost_cents = round(((prompt_tokens * input_rate) + (completion_tokens * output_rate)) * 100, 4)
    if record_cost and _add_openai_cost and cost_cents > 0:
        _add_openai_cost(cost_cents)
    token_usage = {
        "prompt_tokens": prompt_tokens,
        "completion_tokens": completion_tokens,
        "total_tokens": total_tokens,
        "cost_cents": cost_cents,
    }
    cached_tokens = getattr(getattr(getattr(resp, "usage", None), "input_tokens_details", None), "cached_tokens", 0) or 0
    _log_debug(f"{label} - TOKEN USAGE",
               f"Prompt: {prompt_tokens} (cached: {cached_tokens}), Completion: {completion_tokens}, Total: {total_tokens}, Cost: {cost_cents:.4f} cents")

    raw_text = _extract_response_text(resp)
    parsed = _extract_json(raw_text) if parse_json else None
    if parse_json:
        _log_debug(f"{label} - LLM RESPONSE (parsed)", json.dumps(parsed, indent=2, ensure_ascii=False))

    return LLMCallResult(parsed=parsed, raw_text=raw_text, token_usage=token_usage)

class StreamingArrayScanner:
    """Pulls complete objects out of one array of a JSON document that is still
    being streamed.

    The messenger schema puts ``response_chunks`` first (see
    prompts/messenger_prompt.py) precisely so this works: each reply bubble can be
    handed to the client while the model is still writing corrections and
    suggestions. Feed it raw text deltas; it returns whole objects as they close.

    Only tracks the one named array — everything after it is left to a normal
    ``json.loads`` of the completed document.
    """

    def __init__(self, key: str = "response_chunks"):
        self._key = f'"{key}"'
        self._buf = ""
        self._pos = -1          # scan cursor; -1 until the array's '[' is found
        self._depth = 0
        self._obj_start = -1
        self._in_string = False
        self._escape = False
        self.done = False       # the array's closing ']' has been seen

    def feed(self, text: str) -> List[Dict[str, Any]]:
        """Append a text delta; return objects that became complete because of it."""
        if self.done or not text:
            self._buf += text
            return []
        self._buf += text

        if self._pos < 0:
            key_at = self._buf.find(self._key)
            if key_at < 0:
                return []
            bracket = self._buf.find("[", key_at + len(self._key))
            if bracket < 0:
                return []
            self._pos = bracket + 1

        return self._scan()

    def _scan(self) -> List[Dict[str, Any]]:
        out: List[Dict[str, Any]] = []
        i = self._pos
        buf = self._buf
        while i < len(buf):
            ch = buf[i]
            if self._in_string:
                if self._escape:
                    self._escape = False
                elif ch == "\\":
                    self._escape = True
                elif ch == '"':
                    self._in_string = False
            elif ch == '"':
                self._in_string = True
            elif ch == "{":
                if self._depth == 0:
                    self._obj_start = i
                self._depth += 1
            elif ch == "}":
                self._depth -= 1
                if self._depth == 0 and self._obj_start >= 0:
                    raw = buf[self._obj_start:i + 1]
                    self._obj_start = -1
                    try:
                        out.append(json.loads(raw))
                    except json.JSONDecodeError:
                        # Partial/invalid object: drop it here — the completed
                        # document is parsed in full later and wins either way.
                        pass
            elif ch == "]" and self._depth == 0:
                self.done = True
                i += 1
                break
            i += 1
        self._pos = i
        return out

    @property
    def text(self) -> str:
        """Everything fed so far."""
        return self._buf


def stream_llm_for_messenger(
    system_prompt: str,
    user_message: str,
    model: Optional[str] = None,
    temperature: float = 0.2,
    max_output_tokens: int = 600,
    timeout: int = 30,
):
    """Streaming twin of ``call_llm_for_messenger``.

    Yields ``("chunk", <response_chunk dict>)`` for each reply bubble as soon as the
    model finishes writing it, then exactly one ``("done", <full parsed dict>)`` with
    the same shape ``call_llm_for_messenger`` returns (including ``token_usage``).

    Raises on API/parse failure — the caller falls back to the non-streaming path.
    Callers must short-circuit MOCK_MODE before calling this.
    """
    model = model or DEFAULT_MODEL
    client = _init_client()
    if client is None:
        raise RuntimeError("LLM client unavailable (mock mode or missing API key)")

    prompt = system_prompt + "\n\n" + user_message
    scanner = StreamingArrayScanner("response_chunks")
    final_response = None

    stream = client.responses.create(
        model=model,
        input=prompt,
        temperature=temperature,
        max_output_tokens=max_output_tokens,
        timeout=timeout,
        stream=True,
    )

    for event in stream:
        etype = getattr(event, "type", "") or ""
        if etype.endswith("output_text.delta"):
            delta = getattr(event, "delta", "") or ""
            if delta:
                for chunk in scanner.feed(delta):
                    yield "chunk", chunk
        elif etype.endswith("response.completed") or etype == "response.completed":
            final_response = getattr(event, "response", None)
        elif etype.endswith("response.failed") or etype.endswith("response.incomplete"):
            final_response = getattr(event, "response", None)

    raw_text = scanner.text
    parsed = _extract_json(raw_text)
    if not isinstance(parsed, dict):
        raise ValueError("streamed messenger response did not parse to a JSON object")

    prompt_tokens = completion_tokens = total_tokens = 0
    if final_response is not None:
        prompt_tokens, completion_tokens, total_tokens = _extract_token_counts(final_response)
    input_rate, output_rate = MODEL_PRICING.get(model, DEFAULT_PRICING)
    cost_cents = round(((prompt_tokens * input_rate) + (completion_tokens * output_rate)) * 100, 4)
    if _add_openai_cost and cost_cents > 0:
        _add_openai_cost(cost_cents)
    parsed["token_usage"] = {
        "prompt_tokens": prompt_tokens,
        "completion_tokens": completion_tokens,
        "total_tokens": total_tokens,
        "cost_cents": cost_cents,
    }
    _log_debug("MESSENGER STREAM - TOKEN USAGE",
               f"Prompt: {prompt_tokens}, Completion: {completion_tokens}, "
               f"Total: {total_tokens}, Cost: {cost_cents:.4f} cents")

    yield "done", parsed


def translate_texts(
    texts: List[str],
    source_lang: str,
    target_lang: str,
    model: Optional[str] = None,
) -> List[str]:
    """Translate a batch of short sentences. Task 3.8's second call.

    Deliberately context-free: no persona, no output schema, no student model —
    ~100 input tokens against the messenger call's ~2.5k, on the cheapest model in
    MODEL_PRICING. It runs off the critical path while the learner is already
    hearing chunk 1, so latency here costs nothing.

    Returns one translation per input, in order. Raises on API/parse failure —
    the caller degrades to target-only playback rather than stalling.
    """
    if not texts:
        return []

    if MOCK_MODE:
        return [f"[mock {source_lang}->{target_lang}] {t}" for t in texts]

    numbered = "\n".join(f"{i + 1}. {t}" for i, t in enumerate(texts))
    prompt = f"""Translate each numbered {source_lang} sentence into natural, casual {target_lang}.

Rules:
- Translate meaning, not word-for-word. Write what a native {target_lang} speaker would actually say.
- Keep each translation roughly as short as the original — these are spoken aloud back to back.
- Preserve tone: if the original is playful or sarcastic, the translation is too.
- Return exactly {len(texts)} translations, in the same order.

{numbered}

Return ONLY valid JSON (no markdown, no commentary):
{{"translations": ["...", "..."]}}"""

    result = _call_openai_json(
        prompt,
        label="TRANSLATE",
        model=model or TRANSLATE_MODEL,
        temperature=0.3,
        max_output_tokens=400,
    )
    parsed = result.parsed or {}
    out = parsed.get("translations")
    if not isinstance(out, list):
        raise ValueError("translate response missing 'translations' list")
    if len(out) != len(texts):
        raise ValueError(f"translate returned {len(out)} items for {len(texts)} inputs")
    return [str(t) for t in out]


SCENE_FIELDS = ("setting", "character_goal", "user_goal", "complication", "completion_condition")


def generate_scene(
    dimensions: Dict[str, str],
    character_name: str,
    character_bio: str,
    target_language: str,
    model: Optional[str] = None,
) -> Dict[str, str]:
    """Turn a scene dimension draw into a concrete premise (task 5.1).

    Called once per scene (every 5-10 turns), not once per turn, and deliberately
    tiny: no output schema, no student model, no conversation history — just the
    drawn dimensions plus who the character is, on the cheapest model. The
    variety comes from the draw (profile_store.pick_scene_dimensions); this call
    only makes the draw specific enough to play.

    Returns the same five keys it was given, any of which may come back empty if
    the model got that field wrong (see the perspective guard below) — the caller
    merges per field over the draw, so an empty one falls back rather than
    sinking the scene. Raises on API/parse failure, same fallback.
    """
    if MOCK_MODE:
        # The dimensions ARE the fallback scene, so the mock is the fallback path:
        # mock runs exercise scene assembly without pretending a call happened.
        return {key: dimensions.get(key, "") for key in SCENE_FIELDS}

    prompt = f"""You are setting up a short improvised scene for a language-practice chat.

THE CHARACTER: {character_name}
{character_bio}

The scene must be built from exactly these dimensions — keep each one, make each one specific:
- Setting: {dimensions.get('setting', '')}
- {character_name}'s goal: {dimensions.get('character_goal', '')}
- What the learner wants: {dimensions.get('user_goal', '')}
- Complication: {dimensions.get('complication', '')}
- Scene ends when: {dimensions.get('completion_condition', '')}

Rewrite them into one coherent situation:
- Invent the missing specifics — what exactly was broken, who exactly is waiting, what exactly was said last night. Concrete beats generic; a scene about "a favor" is dead, a scene about "the scooter you lent him on Tuesday" is not.
- Keep it in character for {character_name} and plausible in a {target_language}-speaking place. Do not name the learner.
- Everything must be sayable in a 5-10 turn conversation between two people. No third characters who need to speak, no events that have to happen offscreen.
- The completion condition must be reachable through what the two of them SAY: an agreement, a refusal, a confession, a question finally answered. NEVER an external event — no door swinging open, no phone ringing, no third person arriving. {character_name} cannot make those happen by talking, so a scene that ends on one cannot be played to its ending.
- One sentence per field, written in English.

PERSPECTIVE — this is the part that goes wrong most often, so read it twice:
- "character_goal" and "complication" are addressed TO {character_name}, in the second person: "you" IS {character_name}, and the goal is {character_name}'s own. Never write the name "{character_name}" inside either field — if you catch yourself typing it, you have swapped the two people.
- "user_goal" is ABOUT the learner, in the third person: begin it with "the learner". Never "you" in that field.
- "setting" is a plain description of the place. No second person at all.

Return ONLY valid JSON (no markdown, no commentary):
{{"setting": "...", "character_goal": "...", "user_goal": "...", "complication": "...", "completion_condition": "..."}}"""

    result = _call_openai_json(
        prompt,
        label="SCENE",
        model=model or SCENE_MODEL,
        temperature=0.9,  # premise variety is the entire point of this call
        max_output_tokens=400,
    )
    parsed = result.parsed or {}
    scene = {}
    for key in SCENE_FIELDS:
        value = parsed.get(key)
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"scene response missing '{key}'")
        scene[key] = value.strip()

    # Perspective guard. character_goal and complication are written in the
    # second person TO the character, so the character's own name turning up
    # inside one is the signature of the model swapping the two people ("you
    # need Jorge to stall them so you can slip away") — which inverts the scene,
    # since the block is injected under "Your goal (Jorge)". Observed on nano.
    # Blank the field, not the scene: the drawn dimension has the perspective
    # right by construction, so falling back costs specificity and nothing else.
    for key in ("character_goal", "complication"):
        if character_name and character_name.lower() in scene[key].lower():
            print(f"[SCENE] dropped inverted {key} (it names {character_name})")
            scene[key] = ""
    return scene


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
    lang_tag = locale_for(learning.get("code", ""))
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
        result = _call_openai_json(
            prompt,
            label="STORY CARDS GAME",
            model=model,
            temperature=temperature,
            max_output_tokens=600,
            timeout=timeout,
        )
        parsed = result.parsed

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
    valid_phrases: Optional[List[str]] = None,
    required_vocab: Optional[str] = None,
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
        + NEVER_PENALIZE_ACCENTS_RULE
        + STT_TOLERANCE_RULE
        + "- PRIMARY RULE: First ask 'Is the student's answer a correct, natural translation of the English prompt?' — not 'Does it match the reference answer?' The reference answer is just one valid option; other equally valid phrasings exist. If the student's answer correctly and naturally expresses the English prompt, mark it perfect even if it differs from the reference.\n"
        "- accepted: true if the student demonstrated understanding of the meaning, even if imperfectly expressed. Set accepted: false for: wrong conjugation, wrong tense that changes meaning, completely wrong meaning, or core verb/primary action entirely absent from the answer.\n"
        "- damage_multiplier: overall severity across ALL issues combined. Use the lowest applicable value:\n"
        "    1.0   → perfect or asr_error only\n"
        "    0.85  → missing_minor_words\n"
        "    0.8   → gender_agreement | register_too_formal | register_too_informal\n"
        "    0.75  → subtle_meaning_shift | wrong_mood\n"
        "    0.7   → word_order\n"
        "    0.6   → unnatural_phrasing | missing_content\n"
        "    0.0   → wrong_conjugation | wrong_tense | wrong_meaning; accepted must be false\n"
        "- issues: REQUIRED — array of ALL problems found, ordered worst-first. Each item: {\"feedback_key\": str, \"corrected_snippet\": str|null, \"feedback_explanation\": str|null}\n"
        "  If the answer is perfect: [{\"feedback_key\": \"perfect\", \"corrected_snippet\": null, \"feedback_explanation\": null}]\n"
        "  Report ALL issues — do not limit to one. A sentence can have multiple issues (e.g. unnatural word + missing content).\n"
        "  feedback_key values:\n"
        "    perfect: Use whenever the student's answer is a correct, natural translation of the English prompt — a native speaker could say this. This includes valid phrasings that differ from the reference answer. Do NOT downgrade to subtle_meaning_shift just because the phrasing is different from the reference.\n"
        "    asr_error: likely STT mishearing that makes the answer otherwise acceptable.\n"
        "    missing_minor_words: dropped a particle, softener, or minor word (e.g. 'saja', 'ya', 'que').\n"
        "    missing_content: student omitted a secondary detail — a qualifier, supporting clause, or minor element — but the core verb and primary action ARE present. accepted: true, damage 0.6. Do NOT use this when the core verb is missing.\n"
        "    gender_agreement: wrong gender on article/adjective.\n"
        "    register_too_formal: too formal for context (e.g. -kah suffix).\n"
        "    register_too_informal: too casual for context (e.g. 'aja' instead of 'saja').\n"
        "    subtle_meaning_shift: ONLY when the student's phrasing shifts the meaning relative to what the English prompt specifically asked for — e.g. the English says 'one must' (general obligation) but the student said 'we have to' (personal obligation) and that distinction genuinely matters for the prompt. Do NOT use this just because the student picked a different-but-equally-valid phrasing.\n"
        "    wrong_mood: used indicative instead of subjunctive/conditional, but meaning clear.\n"
        "    word_order: words rearranged, meaning still understandable.\n"
        + UNNATURAL_PHRASING_RULE
        + "    wrong_conjugation | wrong_tense: accepted must be false.\n"
        "    wrong_meaning: use this — not missing_content — when the student omitted the core verb or primary action entirely, making the answer incomplete in meaning. E.g. 'vamos a volver' for 'let's try again' (answer: 'vamos a volver a intentarlo') — the verb 'intentar' is completely absent, so the answer doesn't express 'try'. accepted must be false.\n"
        "  corrected_snippet per issue: minimal corrected word/phrase showing the actual fix (wrong word → right word, wrong conjugation → right conjugation, etc.). null if perfect or asr_error. Do NOT produce a corrected_snippet that differs from the student's word only by an accent mark or punctuation — that is not a real error.\n"
        f"  feedback_explanation per issue: ONE sentence in {fluent.get('name', 'English')}. Rules:\n"
        f"    - For subtle_meaning_shift: acknowledge the student's answer is also valid, then name the specific nuance difference. E.g. 'That also works — the reference says X which more specifically conveys [nuance].' Never say the student's answer 'is unnatural' or 'is less natural' if it is actually a natural phrase.\n"
        f"    - For unnatural_phrasing: only use this if you can state a specific, concrete reason it sounds awkward. E.g. 'X is understandable but sounds like a word-for-word translation — a native speaker would say Y instead.' Do NOT say something is unnatural just because the reference uses a different phrasing.\n"
        f"    - For other issues: describe the specific problem and what the fix is.\n"
        f"    - NEVER say 'X is more natural than Y' if Y is also natural. NEVER mention accents, accent marks, punctuation, exclamation marks, or capitalization.\n"
        f"    null if perfect.\n"
        "- corrected_full_answer: write the student's full answer with ALL mistakes fixed, keeping all correct parts word-for-word identical. null if issues is [{perfect}] or [{asr_error}].\n"
        + (
            "- VALID PHRASES: The following words/phrases were explicitly shown to the student as valid vocabulary for this prompt. Do NOT flag any of these as unnatural or incorrect — they are all acceptable: "
            + ", ".join(f'"{_normalize_for_llm(p)}"' for p in valid_phrases)
            + "\n"
            if valid_phrases else ""
        )
        + (
            f"- REQUIRED VOCABULARY: The student MUST use the word \"{required_vocab}\" (or a conjugated/inflected form of it) in their answer. "
            f"If their answer is otherwise correct but does not contain \"{required_vocab}\" or a recognizable conjugation of it, "
            f"set accepted: false, damage_multiplier: 0.0, issues: [{{\"feedback_key\": \"missing_target_word\", \"corrected_snippet\": null, "
            f"\"feedback_explanation\": \"Your answer is correct, but this exercise requires you to use '{required_vocab}' — the word being practiced here.\"}}]\n"
            if required_vocab else ""
        )
        + "Return ONLY valid JSON, no prose."
    )

    # Remove hyphens joining word parts (e.g. "menu-nya" → "menunya") before LLM sees the answer
    user_answer = re.sub(r'(?<=\w)-(?=\w)', '', user_answer)

    # Strip accents and punctuation from the user's answer before sending to the LLM.
    # The LLM receives accent-free text so it cannot flag accent or punctuation differences
    # as errors. We keep the original for _diff_tokens / display.
    user_answer_for_llm = _normalize_for_llm(user_answer)

    all_candidates = accepted_translations if accepted_translations else [correct_answer]
    # Normalize both reference and user answer: strip accents and punctuation so the LLM
    # evaluates only vocabulary, grammar, and meaning — not punctuation or accent marks.
    normalized_candidates = [_normalize_for_llm(c) for c in all_candidates]
    if len(normalized_candidates) > 1:
        refs_str = "\n".join(f"  - {json.dumps(c, ensure_ascii=False)}" for c in normalized_candidates)
        ref_line = f"Accepted answers (any of these is correct):\n{refs_str}"
    else:
        ref_line = f"Reference answer: {json.dumps(normalized_candidates[0], ensure_ascii=False)}"

    user_prompt = (
        f"Prompt ({learning.get('name','Spanish')}): {json.dumps(english_prompt, ensure_ascii=False)}\n"
        f"{ref_line}\n"
        f"Student's answer: {json.dumps(user_answer_for_llm, ensure_ascii=False)}\n\n"
        'Return: {"accepted": bool, "damage_multiplier": float, "issues": [{"feedback_key": str, "corrected_snippet": str|null, "feedback_explanation": str|null}], "corrected_full_answer": str|null}'
    )

    full_prompt = system_prompt + "\n\n" + user_prompt
    _log_debug("BATTLE CHECK - LLM REQUEST", full_prompt)

    try:
        result = _call_openai_json(
            full_prompt,
            label="BATTLE CHECK",
            model=model,
            temperature=temperature,
            max_output_tokens=900,
            timeout=timeout,
        )
        parsed = result.parsed

        parsed.setdefault("accepted", False)
        parsed.setdefault("damage_multiplier", 0.0)
        parsed.setdefault("issues", [])
        parsed.setdefault("corrected_full_answer", None)

        # Derive legacy single-issue fields from primary (worst) issue for backward compat
        issues = parsed.get("issues") or []
        primary = issues[0] if issues else {}
        parsed["feedback_key"] = primary.get("feedback_key", None)
        parsed["corrected_snippet"] = primary.get("corrected_snippet", None)
        parsed["feedback_explanation"] = primary.get("feedback_explanation", None)

        # Compute correction_tokens algorithmically from user_answer vs corrected_full_answer
        corrected_full = parsed.get("corrected_full_answer")
        primary_fk = parsed["feedback_key"]
        if corrected_full and primary_fk and primary_fk not in ("asr_error", "perfect") and user_answer:
            parsed["correction_tokens"] = _diff_tokens(user_answer, corrected_full)
        else:
            parsed["correction_tokens"] = None

        # Enforce consistency: these keys must always result in accepted: true
        # (LLM sometimes ignores the prompt instruction)
        ALWAYS_ACCEPT_MULTIPLIERS = {
            "perfect": 1.0,
            "asr_error": 1.0,
            "missing_minor_words": 0.85,
            "missing_content": 0.6,
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

        parsed["token_usage"] = result.token_usage

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
            "issues": [],
            "feedback_key": None,
            "corrected_snippet": None,
            "correction_tokens": None,
        }


def call_llm_for_messenger(
    system_prompt: str,
    user_message: str,
    model: Optional[str] = None,
    temperature: float = 0.2,
    max_output_tokens: int = 800,
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
        result = _call_openai_json(
            full_prompt,
            label="MESSENGER CHAT",
            model=model,
            temperature=temperature,
            max_output_tokens=max_output_tokens,
            timeout=timeout,
        )
        parsed = result.parsed

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
        parsed["token_usage"] = result.token_usage

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


def call_llm_for_grammar_chat(
    context: dict,
    messages: list,
    model: Optional[str] = None,
    temperature: float = 0.3,
    timeout: int = 30,
) -> str:
    """
    Multi-turn grammar tutor chat grounded in the current exercise context.
    Returns the AI reply as a plain string.
    """
    model = model or DEFAULT_MODEL
    client = _init_client()

    if client is None:
        return "I can't explain right now (mock mode is on), but the key rule is: with verbs like 'gustar' and 'dar ganas de', the indirect object pronoun (me, te, le…) marks *who* has the feeling and is almost always required."

    learning_lang = context.get("learning_lang", "Spanish")
    fluent_lang = context.get("fluent_lang", "English")
    word_key = context.get("word_key", "")
    english = context.get("english", "")
    correct_answer = context.get("correct_answer", "")
    user_answer = context.get("user_answer", "")
    feedback_key = context.get("feedback_key", "")
    feedback_explanation = context.get("feedback_explanation", "")

    system_prompt = f"""You are a friendly {learning_lang} grammar tutor. \
The learner is a native {fluent_lang} speaker practicing {learning_lang}.
Keep all explanations in {fluent_lang} unless asked otherwise.
Be concise (2–4 sentences per reply). Use examples in {learning_lang} with {fluent_lang} translations.

Current exercise:
  Word / verb being practiced: {word_key}
  English prompt: {english}
  Learner's answer: {user_answer}
  Correct answer: {correct_answer}
  Issue detected: {feedback_key}{(" — " + feedback_explanation) if feedback_explanation else ""}

Answer the learner's question based on this context."""

    # Format conversation history as a single string
    history_lines = []
    for msg in messages:
        role_label = "Student" if msg.get("role") == "user" else "Tutor"
        history_lines.append(f"{role_label}: {msg.get('content', '')}")
    history_lines.append("Tutor:")
    full_prompt = system_prompt + "\n\n" + "\n\n".join(history_lines)

    try:
        result = _call_openai_json(
            full_prompt,
            label="GRAMMAR CHAT",
            model=model,
            temperature=temperature,
            max_output_tokens=400,
            timeout=timeout,
            parse_json=False,
        )
        text = result.raw_text.strip()
        return text if text else "Sorry, I couldn't generate a response."
    except Exception as e:
        print("Grammar chat LLM error:", e)
        return "Sorry, something went wrong. Please try again."


def call_llm_for_freeform_correction(
    user_sentence: str,
    word_key: str,
    usecase_name: str,
    learning_lang: str = "Spanish",
    fluent_lang: str = "English",
    model=None,
    temperature: float = 0.15,
    timeout: int = 20,
) -> dict:
    """Correct a freeform learner sentence; return correction_tokens + feedback_message."""
    import json as _json
    model = model or DEFAULT_MODEL
    client = _init_client()

    if client is None:
        return {
            "correction_tokens": [{"text": user_sentence, "status": "keep"}],
            "feedback_message": "(mock mode — no correction)",
        }

    system_prompt = (
        f"You are a {learning_lang} grammar corrector. The learner is practicing the word/phrase "
        f'"{word_key}" (use case: {usecase_name}).\n'
        f"Correct the learner's {learning_lang} sentence. Respond ONLY with JSON:\n"
        '{"corrected": "...", "feedback": "one-sentence feedback in '
        f'{fluent_lang}, or empty string if perfect"' + "}"
    )

    try:
        result = _call_openai_json(
            [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_sentence},
            ],
            label="FREEFORM CORRECTION",
            model=model,
            temperature=temperature,
            max_output_tokens=200,
            timeout=timeout,
            parse_json=False,
        )
        text = result.raw_text.strip()
        if text.startswith("```"):
            text = text.split("```")[1]
            if text.startswith("json"):
                text = text[4:]
        data = _json.loads(text.strip())
        corrected = data.get("corrected", user_sentence)
        feedback = data.get("feedback", "")
        tokens = _diff_tokens(user_sentence, corrected)
        return {"correction_tokens": tokens, "feedback_message": feedback}
    except Exception as e:
        print("Freeform correction error:", e)
        return {
            "correction_tokens": [{"text": user_sentence, "status": "keep"}],
            "feedback_message": "Couldn't check this sentence.",
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
        result = _call_openai_json(
            full_prompt,
            label="GUESSING GAME - PICK SECRET",
            model=model,
            temperature=temperature,
            max_output_tokens=50,
            timeout=timeout,
            parse_json=False,
        )

        # Clean up the response
        secret = result.raw_text.strip().lower()
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
        result = _call_openai_json(
            full_prompt,
            label="GUESSING GAME - TURN",
            model=model,
            temperature=temperature,
            max_output_tokens=150,
            timeout=timeout,
        )
        parsed = result.parsed
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
