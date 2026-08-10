"""On-demand chunk translation (task 3.8).

The messenger character speaks only the target language. UI-language translations
are fetched here, by the client, on demand.

As of task 3.13, the client's default screen-on behaviour is to fetch one for
every chunk but the reaction opener (`response_chunks[0]`), regardless of
`pairingMode`, to show as an ephemeral "thought" before each bubble. `pairingMode`
separately still governs whether the turn's *audio* additionally speaks or
substitutes a translation (`pairs` speaks it before the target clip, `alternating`
substitutes it for every other chunk, `targetOnly` does neither) — but by task
3.13 that no longer changes whether this endpoint gets called, only whether its
result is also read aloud.

Keeping this out of the messenger turn is what keeps a mode switch retroactive:
one prompt shape serves every mode, and translations already fetched for the
visual thought are reused instead of re-fetched when audio pairing wants them too.
"""
from typing import List, Optional

from fastapi import APIRouter
from pydantic import BaseModel

import translation_store
from settings import MOCK_MODE

router = APIRouter()


class TranslateRequest(BaseModel):
    texts: List[str]
    source_lang: Optional[str] = "Spanish"
    target_lang: Optional[str] = "English"


class TranslateResponse(BaseModel):
    translations: List[Optional[str]]  # None = translation unavailable for that text
    cache_hits: int
    ok: bool  # False when the LLM leg failed; caller degrades to target-only


@router.post("/api/messenger/translate", response_model=TranslateResponse)
def messenger_translate(req: TranslateRequest):
    """Translate chunk texts, serving what it can from cache.

    Never raises: a failure returns ok=false with nulls in place of the missing
    translations, because the client's fallback is to play the target audio alone.
    Pairing mode must never be able to hang the conversation.
    """
    from llm_call import translate_texts

    source = req.source_lang or "Spanish"
    target = req.target_lang or "English"

    results: List[Optional[str]] = []
    misses: List[int] = []
    for i, text in enumerate(req.texts):
        cached = translation_store.get(text, source, target)
        results.append(cached)
        if cached is None and text and text.strip():
            misses.append(i)

    cache_hits = sum(1 for r in results if r is not None)

    if not misses:
        return TranslateResponse(translations=results, cache_hits=cache_hits, ok=True)

    ok = True
    try:
        fresh = translate_texts([req.texts[i] for i in misses], source, target)
        for idx, translation in zip(misses, fresh):
            results[idx] = translation
        # Mock translations are placeholders — caching them would poison real runs.
        if not MOCK_MODE:
            translation_store.put_many(
                [(req.texts[i], source, target, results[i]) for i in misses]
            )
    except Exception as e:
        print(f"[TRANSLATE] failed for {len(misses)} text(s), returning nulls: {e}")
        ok = False

    return TranslateResponse(translations=results, cache_hits=cache_hits, ok=ok)
