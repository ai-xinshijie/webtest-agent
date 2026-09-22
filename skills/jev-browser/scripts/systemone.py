#!/usr/bin/env python3
"""Send a Jev SystemOne request and validate the response.

This helper only handles the decision request. It does not execute browser
actions or interpret the selected target. The calling project should map the
validated answer to its own browser harness.

Environment variables:
    OPENROUTER_API_KEY   Required bearer token.
    JEV_MODEL            Optional. Defaults to typesafe/jev-1.13.
    JEV_MODEL_URL        Optional. Defaults to https://openrouter.ai/api/v1/systemone.
    JEV_TEXT_MODEL       Optional text helper model. Defaults to google/gemini-2.5-flash-lite.
    JEV_TEXT_MODEL_URL   Optional text helper URL. Defaults to https://openrouter.ai/api/v1/chat/completions.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

DEFAULT_MODEL = "typesafe/jev-1.13"
DEFAULT_URL = "https://openrouter.ai/api/v1/systemone"


def load_json(value: str) -> Any:
    """Load JSON from a literal string or a path to a JSON file."""
    candidate = Path(value)
    if candidate.exists() and candidate.is_file():
        return json.loads(candidate.read_text(encoding="utf-8"))
    return json.loads(value)


def validate_choice(answer: dict[str, Any], criteria: dict[str, Any]) -> None:
    """Validate a SystemOne choice answer before it can be consumed."""
    choice = answer.get("choice")
    probabilities = answer.get("probabilities")
    if choice not in criteria:
        raise ValueError(f"Invalid choice: {choice!r}")
    if not isinstance(probabilities, dict) or set(probabilities) != set(criteria):
        raise ValueError("Probabilities do not match the request criteria")
    values = list(probabilities.values())
    if not all(isinstance(v, (int, float)) and math.isfinite(v) and 0 <= v <= 1 for v in values):
        raise ValueError("Probabilities must be finite numbers between 0 and 1")
    if abs(sum(values) - 1.0) > 0.02:
        raise ValueError("Probabilities do not sum to 1 within tolerance")
    if probabilities[choice] < max(values) - 1e-9:
        raise ValueError("Selected choice is not the highest-probability option")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state", required=True, help="JSON state or path to a JSON state file")
    parser.add_argument("--questions", required=True, help="JSON questions or path to a JSON questions file")
    parser.add_argument(
        "--model",
        default=os.environ.get("JEV_MODEL", DEFAULT_MODEL),
        help="SystemOne model ID (default: JEV_MODEL or typesafe/jev-1.13)",
    )
    parser.add_argument(
        "--url",
        default=os.environ.get("JEV_MODEL_URL", DEFAULT_URL),
        help="Full SystemOne endpoint URL (default: JEV_MODEL_URL or OpenRouter)",
    )
    args = parser.parse_args()

    api_key = os.environ.get("OPENROUTER_API_KEY")
    if not api_key:
        print("OPENROUTER_API_KEY is required", file=sys.stderr)
        return 2

    state = load_json(args.state)
    questions = load_json(args.questions)
    if not isinstance(questions, dict) or not questions:
        print("Questions must be a non-empty JSON object", file=sys.stderr)
        return 2

    body = {
        "model": args.model,
        "state": state,
        "questions": questions,
    }
    request = urllib.request.Request(
        args.url,
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            result = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        print(f"SystemOne HTTP {error.code}: {detail}", file=sys.stderr)
        return 1
    except (urllib.error.URLError, TimeoutError) as error:
        print(f"SystemOne connection failed: {error}", file=sys.stderr)
        return 1
    except json.JSONDecodeError as error:
        print(f"SystemOne returned invalid JSON: {error}", file=sys.stderr)
        return 1

    answers = result.get("answers")
    if not isinstance(answers, dict):
        print("SystemOne response has no answers object", file=sys.stderr)
        return 1

    try:
        for question_id, question in questions.items():
            answer = answers.get(question_id)
            if not isinstance(answer, dict):
                raise ValueError(f"Missing answer for {question_id!r}")
            criteria = question.get("criteria")
            if question.get("type") == "choice" and isinstance(criteria, dict):
                validate_choice(answer, criteria)
    except ValueError as error:
        print(f"Invalid SystemOne answer: {error}", file=sys.stderr)
        return 1

    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
