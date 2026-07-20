#!/usr/bin/env python3
"""
asr-whisper.py — the DEFAULT persistent ASR worker for Argus Presenter (Plan 0470).

WARM by construction (RT-17/25): the faster-whisper model is loaded ONCE at startup and
then serves many segments. The process stays alive across utterances — it is NEVER
re-spawned per segment. Argus Presenter (app/asr.mjs) supervises it and watchdog-restarts
it on crash.

Line protocol (matches app/asr.mjs):
    stdin : one absolute WAV path per line (16 kHz mono PCM16, produced by the server)
    stdout: one JSON result line per request, in order:
              {"text": "...", "conf": 0.0..1.0, "seq": null}
            plus a one-time readiness marker on startup:
              {"ready": true}

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
import json

# Known whisper hallucination strings on near-silent input (RT-12).
_HALLUCINATIONS = {"you", "thank you.", "thanks for watching!", "thank you very much.", ""}


def _emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def main():
    model_name = os.environ.get("PRESENTER_WHISPER_MODEL", "base.en")
    device = os.environ.get("PRESENTER_WHISPER_DEVICE", "cpu")
    compute = os.environ.get("PRESENTER_WHISPER_COMPUTE", "int8")

    try:
        from faster_whisper import WhisperModel
    except Exception as e:  # noqa: BLE001
        _emit({"ready": False, "error": "faster-whisper not installed: %s" % e})
        # Stay alive but answer every request with empty text so the server never hangs.
        for _ in sys.stdin:
            _emit({"text": "", "conf": 0.0, "seq": None})
        return

    # WARM: load the model ONCE here, before the request loop.
    model = WhisperModel(model_name, device=device, compute_type=compute)
    _emit({"ready": True})

    for line in sys.stdin:
        wav = line.strip()
        if not wav:
            continue
        try:
            segments, _info = model.transcribe(wav, language="en", vad_filter=True)
            parts, confs = [], []
            for seg in segments:
                parts.append(seg.text)
                # avg_logprob -> a rough 0..1 confidence
                if getattr(seg, "avg_logprob", None) is not None:
                    import math
                    confs.append(max(0.0, min(1.0, math.exp(seg.avg_logprob))))
            text = " ".join(p.strip() for p in parts).strip()
            conf = sum(confs) / len(confs) if confs else None
            if text.lower() in _HALLUCINATIONS:
                text = ""
            _emit({"text": text, "conf": conf, "seq": None})
        except Exception as e:  # noqa: BLE001
            _emit({"text": "", "conf": 0.0, "seq": None, "error": str(e)})


if __name__ == "__main__":
    main()
