"""SpeakRight backend entry point — assembles the FastAPI app from the feature
routers. Run with `python main.py` or `uvicorn main:app --reload --port 8000`.
(`uvicorn game_backend:app` still works via the compat shim.)
"""
import settings  # noqa: F401  — must be first: loads .env and creates state dirs

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from usage_tracker import startup_commit
from routers import audio, checks, guessing, messenger, misc, quiz, story, worddrill

app = FastAPI(title="Story Cards Game Backend")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.on_event("startup")
async def on_startup():
    startup_commit()


for r in (story, audio, misc, checks, messenger, guessing, quiz, worddrill):
    app.include_router(r.router)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
