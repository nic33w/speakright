"""Legacy entry point — the app now lives in main.py + routers/ (see CLAUDE.md).

Kept so `uvicorn game_backend:app` and `python game_backend.py` keep working.
"""
from main import app  # noqa: F401

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
