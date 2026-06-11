import json
from datetime import datetime
from pathlib import Path

USAGE_FILE = Path(__file__).resolve().parent / "usage_data.json"
MAX_AZURE_CHARS = 500_000

_data: dict | None = None


def _default_data() -> dict:
    return {
        "azure": {
            "monthly_chars": 0,
            "month_key": datetime.now().strftime("%Y-%m"),
            "pending_sessions": [],
            "current_session": None,
        }
    }


def _load_from_file() -> dict:
    if USAGE_FILE.exists():
        try:
            with open(USAGE_FILE, "r") as f:
                return json.load(f)
        except Exception:
            pass
    return _default_data()


def _save():
    global _data
    with open(USAGE_FILE, "w") as f:
        json.dump(_data, f, indent=2)


def _get() -> dict:
    global _data
    if _data is None:
        _data = _load_from_file()
    return _data


def _check_and_reset_monthly(d: dict):
    current_key = datetime.now().strftime("%Y-%m")
    azure = d["azure"]
    if azure.get("month_key", "") != current_key:
        azure["monthly_chars"] = 0
        azure["pending_sessions"] = []
        azure["current_session"] = None
        azure["month_key"] = current_key


def _commit_all_sessions(d: dict):
    azure = d["azure"]
    current = azure.get("current_session")
    if current and current.get("chars", 0) > 0:
        azure.setdefault("pending_sessions", []).append(current)
        azure["current_session"] = None
    total = sum(s.get("chars", 0) for s in azure.get("pending_sessions", []))
    azure["monthly_chars"] = azure.get("monthly_chars", 0) + total
    azure["pending_sessions"] = []


def startup_commit():
    """On server startup: fold all sessions from the previous run into the monthly total."""
    d = _get()
    _check_and_reset_monthly(d)
    _commit_all_sessions(d)
    _save()


def start_new_session(mode: str):
    """Called when the user enters a game mode. Saves the previous session to pending."""
    d = _get()
    azure = d["azure"]
    current = azure.get("current_session")
    if current and current.get("chars", 0) > 0:
        azure.setdefault("pending_sessions", []).append(current)
    azure["current_session"] = {
        "mode": mode,
        "chars": 0,
        "started_at": datetime.now().isoformat(),
    }
    _save()


def add_azure_chars(n: int):
    """Increment the current session's Azure TTS character count. Call after each real Azure TTS call."""
    d = _get()
    azure = d["azure"]
    if azure.get("current_session") is None:
        azure["current_session"] = {
            "mode": "unknown",
            "chars": 0,
            "started_at": datetime.now().isoformat(),
        }
    azure["current_session"]["chars"] = azure["current_session"].get("chars", 0) + n
    _save()


def get_summary() -> dict:
    d = _get()
    azure = d["azure"]
    return {
        "azure": {
            "monthly_chars": azure.get("monthly_chars", 0),
            "month_key": azure.get("month_key", ""),
            "pending_sessions": azure.get("pending_sessions", []),
            "current_session": azure.get("current_session"),
            "max_chars": MAX_AZURE_CHARS,
        }
    }
