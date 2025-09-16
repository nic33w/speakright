# SpeakRight — local Spanish speaking practice (demo)

**One-liner:** Record, get instant structured feedback, and hear a corrected playback — all locally.

## Demo
![demo-gif.gif](./demo/demo-gif.gif)

## Why
I built this to practice conversational Spanish with private, instant feedback and to explore local speech+LLM pipelines.

## Tech
- Frontend: React
- STT: whisper.cpp (local)
- LLM: local LLaMA / API
- TTS: (local or Azure)
- Orchestration: (optional) LangChain / ClaudeCode

## Run (dev)
```bash
# install
npm install

# start frontend
npm run dev

# start backend
cd server && pip install -r requirements.txt
python server.py
