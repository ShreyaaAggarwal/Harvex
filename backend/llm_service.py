"""
HARVEX — LLM Service
-----------------------
Thin wrapper the agents use ONLY for contextual reasoning / explanation
text — never for arithmetic, shelf-life math or waste calculations
(those are deterministic, see agents/*.py).

If ANTHROPIC_API_KEY is set in the environment, this calls the real
Anthropic Messages API over a plain HTTPS request (no SDK dependency
required). If the key is missing, unreachable, or the call fails for any
reason, HARVEX falls back to a deterministic template-based explainer and
clearly marks the response as "Simulation mode" — the product must stay
demoable without a live external service.
"""

import os
import json
import urllib.request
import urllib.error

ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "").strip()
ANTHROPIC_MODEL = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-4-6")
API_URL = "https://api.anthropic.com/v1/messages"


class LLMService:
    def __init__(self):
        self.live_mode = bool(ANTHROPIC_API_KEY)

    def explain(self, system_prompt: str, context: dict, fallback_text: str) -> dict:
        """
        Returns {"text": str, "mode": "live"|"simulation"}
        `fallback_text` is a fully-formed deterministic explanation the
        caller has already built from real numbers — used whenever the
        live call is unavailable, so the UI never blocks on the LLM.
        """
        if not self.live_mode:
            return {"text": fallback_text, "mode": "simulation"}

        try:
            body = json.dumps({
                "model": ANTHROPIC_MODEL,
                "max_tokens": 220,
                "system": system_prompt,
                "messages": [
                    {"role": "user", "content": json.dumps(context, default=str)}
                ],
            }).encode("utf-8")
            req = urllib.request.Request(
                API_URL,
                data=body,
                headers={
                    "Content-Type": "application/json",
                    "x-api-key": ANTHROPIC_API_KEY,
                    "anthropic-version": "2023-06-01",
                },
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=8) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                text_blocks = [b["text"] for b in data.get("content", []) if b.get("type") == "text"]
                text = " ".join(text_blocks).strip() or fallback_text
                return {"text": text, "mode": "live"}
        except Exception:
            # Any failure (no network, bad key, timeout) -> deterministic fallback.
            return {"text": fallback_text, "mode": "simulation"}


llm_service = LLMService()
