#!/usr/bin/env python3
"""
asr-whisper.py — the DEFAULT persistent ASR worker for Argus Presenter (Plan 0470).

WARM by construction (RT-17/25): the faster-whisper model is loaded ONCE at startup and
then serves many segments. The process stays alive across utterances — it is NEVER
re-spawned per segment. Argus Presenter (app/asr.mjs) supervises it and watchdog-restarts
it on crash.

Protocol (matches app/asr.mjs; Plan 0904 V1.8 — BYTES, NOT A PATH):
    stdin : "#<id> <n>\n" followed by exactly <n> bytes of WAV (16 kHz mono PCM16)
    stdout: one JSON result line per request:
              {"id": <id>, "text": "...", "conf": 0.0..1.0}
            plus a one-time readiness marker on startup:
              {"ready": true, "recognizer": {...}}
    No file is read or written: the worker can run on another host behind any command that
    carries stdin/stdout (e.g. `ssh <host> python3 asr-whisper.py`).

Swap engines via PRESENTER_ASR_CMD (this file is only the default). Keep the model-load
OUTSIDE the per-request loop or you reintroduce the cold-start latency this design forbids.

Setup (documented — NOT installed by the plan/tests; the CI suite uses a stub worker):
    python3 -m venv ~/.venvs/ap-asr
    ~/.venvs/ap-asr/bin/pip install faster-whisper
    PRESENTER_ASR_CMD="~/.venvs/ap-asr/bin/python /path/to/argus-presenter/voice/asr-whisper.py"

Env knobs:
    PRESENTER_WHISPER_MODEL   faster-whisper model name (default: "base.en")
    PRESENTER_WHISPER_DEVICE  "cpu" (default) | "cuda"
    PRESENTER_WHISPER_COMPUTE compute type (default: "int8")

Hallucination filtering (RT-12) is applied server-side AND here (short/blank guard).
"""
import sys
import os
import io
import json
import math

# Known whisper hallucination strings on near-silent input (RT-12).
_HALLUCINATIONS = {"you", "thank you.", "thanks for watching!", "thank you very much.", ""}


def _emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def _requests():
    """Yield (id, wav_bytes) for each "#<id> <n>\\n<n bytes>" request on stdin, until EOF."""
    rd = sys.stdin.buffer
    while True:
        head = rd.readline()
        if not head:
            return
        head = head.decode("utf-8", "replace").strip()
        if not head.startswith("#"):
            continue
        try:
            rid_s, n_s = head[1:].split(" ", 1)
            rid, n = int(rid_s), int(n_s)
        except ValueError:
            continue
        body = rd.read(n)
        if body is None or len(body) < n:
            return
        yield rid, body


def main():
    model_name = os.environ.get("PRESENTER_WHISPER_MODEL", "base.en")
    device = os.environ.get("PRESENTER_WHISPER_DEVICE", "cpu")
    compute = os.environ.get("PRESENTER_WHISPER_COMPUTE", "int8")

    try:
        from faster_whisper import WhisperModel
    except Exception as e:  # noqa: BLE001
        _emit({"ready": False, "error": "faster-whisper not installed: %s" % e})
        # Stay alive but answer every request with empty text so the server never hangs.
        for rid, _wav in _requests():
            _emit({"id": rid, "text": "", "conf": 0.0, "error": "no-engine"})
        return

    # WARM: load the model ONCE here, before the request loop.
    model = WhisperModel(model_name, device=device, compute_type=compute)
    try:
        import faster_whisper
        version = getattr(faster_whisper, "__version__", None)
    except Exception:  # noqa: BLE001
        version = None
    _emit({"ready": True, "recognizer": {"side": "server", "engine": "faster-whisper", "model": model_name,
                                          "quant": compute, "version": version, "backend": "ct2"}})

    for rid, wav in _requests():
        try:
            segments, _info = model.transcribe(io.BytesIO(wav), language="en", vad_filter=True)
            parts, confs = [], []
            for seg in segments:
                parts.append(seg.text)
                # avg_logprob -> a rough 0..1 confidence
                if getattr(seg, "avg_logprob", None) is not None:
                    confs.append(max(0.0, min(1.0, math.exp(seg.avg_logprob))))
            text = " ".join(p.strip() for p in parts).strip()
            conf = sum(confs) / len(confs) if confs else None
            if text.lower() in _HALLUCINATIONS:
                text = ""
            _emit({"id": rid, "text": text, "conf": conf})
        except Exception as e:  # noqa: BLE001
            _emit({"id": rid, "text": "", "conf": 0.0, "error": str(e)})

if __name__ == "__main__":
    main()
