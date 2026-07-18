"""Word Drill mode: the 7 /api/worddrill/* endpoints and their sentence-bank
loader (word_practice_sentences.json / _id.json).
"""
import json
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from models import LangSpec
from settings import API_ROOT

router = APIRouter()

WORD_PRACTICE_DATA: Optional[Dict[str, Any]] = None


def _load_word_practice_data(lang: str = "es") -> Dict[str, Any]:
    filename = "word_practice_sentences_id.json" if lang == "id" else "word_practice_sentences.json"
    data_path = API_ROOT / filename
    with open(data_path, "r", encoding="utf-8") as f:
        return json.load(f)


@router.get("/api/worddrill/words")
def api_worddrill_words(lang: str = Query("es")):
    data = _load_word_practice_data(lang)
    words = [
        {"key": key, "display": info["display"], "description": info["description"]}
        for key, info in data.items()
    ]
    return {"words": words}


class WordDrillSentenceReq(BaseModel):
    word: str
    exclude_ids: List[int] = []
    lang: str = "es"


@router.post("/api/worddrill/sentence")
def api_worddrill_sentence(req: WordDrillSentenceReq):
    import random
    data = _load_word_practice_data(req.lang)
    if req.word not in data:
        raise HTTPException(status_code=404, detail=f"Word '{req.word}' not found")

    sentences = data[req.word]["sentences"]
    available = [s for s in sentences if s["id"] not in req.exclude_ids]
    if not available:
        available = sentences  # reset if all used

    sentence = random.choice(available)
    return {"sentence": sentence}


@router.get("/api/worddrill/sentences/{word}")
def api_worddrill_sentences(word: str, lang: str = Query("es")):
    data = _load_word_practice_data(lang)
    if word not in data:
        raise HTTPException(status_code=404, detail=f"Word '{word}' not found")
    return {"sentences": data[word]["sentences"]}


@router.get("/api/worddrill/usecases/{word}")
def api_worddrill_usecases(word: str, lang: str = Query("es")):
    data = _load_word_practice_data(lang)
    if word not in data:
        raise HTTPException(status_code=404, detail=f"Word '{word}' not found")
    word_data = data[word]
    usecases = word_data.get("usecases", [])
    conjugations = word_data.get("conjugations")
    return {"usecases": usecases, "conjugations": conjugations}


class WordDrillCheckReq(BaseModel):
    user_answer: str
    correct_answer: str
    accepted_translations: List[str] = []
    prompt_text: str
    context: str = ""
    valid_phrases: Optional[List[str]] = None
    learning: Optional[LangSpec] = None
    fluent: Optional[LangSpec] = None


@router.post("/api/worddrill/check")
def api_worddrill_check(req: WordDrillCheckReq):
    from llm_call import check_trivia_answer

    fluent = req.fluent or LangSpec(code="en", name="English")
    learning = req.learning or LangSpec(code="es", name="Spanish")

    try:
        result = check_trivia_answer(
            user_answer=req.user_answer,
            correct_answer=req.correct_answer,
            english_prompt=req.prompt_text,
            fluent=fluent.dict(),
            learning=learning.dict(),
            accepted_translations=req.accepted_translations,
            valid_phrases=req.valid_phrases or None,
        )
        return {
            "accepted": result.get("accepted", False),
            "damage_multiplier": result.get("damage_multiplier", 0.0),
            "issues": result.get("issues", []),
            "feedback_key": result.get("feedback_key"),
            "corrected_snippet": result.get("corrected_snippet"),
            "feedback_explanation": result.get("feedback_explanation"),
            "correction_tokens": result.get("correction_tokens"),
            "fast_path": result.get("fast_path", False),
            "token_usage": result.get("token_usage"),
        }
    except Exception as e:
        print("Word drill check failed:", e)
        import traceback
        traceback.print_exc()
        return {
            "accepted": False,
            "damage_multiplier": 0.0,
            "feedback_key": None,
            "corrected_snippet": None,
            "token_usage": None,
        }


class GrammarChatMessage(BaseModel):
    role: str  # "user" or "assistant"
    content: str


class GrammarChatReq(BaseModel):
    messages: List[GrammarChatMessage]
    context: Dict[str, Any]


@router.post("/api/worddrill/chat")
def api_worddrill_chat(req: GrammarChatReq):
    from llm_call import call_llm_for_grammar_chat
    try:
        reply = call_llm_for_grammar_chat(
            context=req.context,
            messages=[{"role": m.role, "content": m.content} for m in req.messages],
        )
        return {"reply": reply}
    except Exception as e:
        print("Grammar chat error:", e)
        return {"reply": "Sorry, something went wrong. Please try again."}


class FreeformReq(BaseModel):
    user_sentence: str
    word_key: str = ""
    usecase_name: str = ""
    learning_lang: str = "Spanish"
    fluent_lang: str = "English"


@router.post("/api/worddrill/freeform")
def api_worddrill_freeform(req: FreeformReq):
    from llm_call import call_llm_for_freeform_correction
    try:
        result = call_llm_for_freeform_correction(
            user_sentence=req.user_sentence,
            word_key=req.word_key,
            usecase_name=req.usecase_name,
            learning_lang=req.learning_lang,
            fluent_lang=req.fluent_lang,
        )
        return result
    except Exception as e:
        print("Freeform correction error:", e)
        return {
            "correction_tokens": [{"text": req.user_sentence, "status": "keep"}],
            "feedback_message": "Couldn't check this sentence.",
        }
