# SystemOne protocol

OpenRouter exposes Jev through the SystemOne endpoint, not through the ordinary chat-completions endpoint.

```text
POST https://openrouter.ai/api/v1/systemone
Authorization: Bearer $OPENROUTER_API_KEY
Content-Type: application/json
```

Configure the endpoint with environment variables when the integration is reusable:

```text
OPENROUTER_API_KEY=...
JEV_MODEL=typesafe/jev-1.13
JEV_MODEL_URL=https://openrouter.ai/api/v1/systemone
JEV_TEXT_MODEL=google/gemini-2.5-flash-lite
JEV_TEXT_MODEL_URL=https://openrouter.ai/api/v1/chat/completions
```

`JEV_MODEL_URL` and `JEV_TEXT_MODEL_URL` are full request URLs. Keep the API key out of source control.

`typesafe/jev-1.13` is the default model. OpenRouter also accepts the bare SystemOne model ID `jev-1.13` and maps it to the `typesafe/` namespace.

## Request

A request has three required top-level fields:

- `model`
- `state`
- `questions`

`state` may be a string, object, or array. For browser work, prefer a structured object that describes the current page and the observed elements.

```json
{
  "model": "typesafe/jev-1.13",
  "state": {
    "goal": "Find one-way flights from Zurich to London on September 20, 2026.",
    "page": {
      "url": "https://example.test/flights",
      "title": "Flights",
      "text": "Visible page text"
    },
    "elements": [
      {
        "index": "1",
        "role": "button",
        "label": "Search",
        "operations": ["CLICK"]
      },
      {
        "index": "2",
        "role": "textbox",
        "label": "From",
        "value": "Zurich",
        "operations": ["TYPE_TEXT", "CLICK"]
      }
    ],
    "recent_actions": []
  },
  "questions": {
    "operation": {
      "type": "choice",
      "instructions": "Choose the next operation that advances the goal.",
      "criteria": {
        "CLICK": "Click an element, button, menu option, suggestion, or calendar day.",
        "TYPE_TEXT": "Enter or replace text in an editable field.",
        "SELECT": "Choose an observed dropdown value.",
        "SCROLL_UP": "Scroll the page up.",
        "SCROLL_DOWN": "Scroll the page down.",
        "WAIT": "Wait for a needed control or result to appear.",
        "DONE": "Every requirement is visibly satisfied.",
        "BLOCKED": "No supported operation can make progress."
      }
    },
    "click_target": {
      "type": "choice",
      "instructions": "If the next operation is CLICK, choose the best target from the observed elements.",
      "criteria": {
        "1": { "element": "[1] button Search" }
      }
    },
    "type_text_target": {
      "type": "choice",
      "instructions": "If the next operation is TYPE_TEXT, choose the best editable target.",
      "criteria": {
        "2": { "element": "[2] textbox From", "current_value": "Zurich" }
      }
    }
  }
}
```

Target questions are speculative. Include one target head per operation that has at least one compatible element, then consume only the answer for the selected operation.

## Response

The response contains one answer per requested question.

```json
{
  "id": "gen-...",
  "model": "typesafe/jev-1.13-20260917",
  "provider": "TypeSafe",
  "answers": {
    "operation": {
      "type": "choice",
      "choice": "CLICK",
      "confidence": 0.91,
      "probabilities": {
        "CLICK": 0.91,
        "TYPE_TEXT": 0.02,
        "SELECT": 0.0,
        "SCROLL_UP": 0.0,
        "SCROLL_DOWN": 0.03,
        "WAIT": 0.01,
        "DONE": 0.0,
        "BLOCKED": 0.03
      }
    },
    "click_target": {
      "type": "choice",
      "choice": "1",
      "confidence": 1.0,
      "probabilities": { "1": 1.0 }
    }
  },
  "usage": {
    "input_tokens": 812,
    "output_tokens": 42,
    "cost": 0.00003
  }
}
```

## Validation rules

Before executing anything, enforce these rules in code:

- The selected operation must exist in the request's `operation.criteria`.
- If the operation requires a target, the selected target must exist in the matching target question.
- The keys of `probabilities` must match the request's criteria.
- Each probability must be a finite number between `0` and `1`.
- The probabilities should sum to `1` within a small tolerance.
- The selected choice must be one of the highest-probability options.
- Do not treat `confidence` as proof that the goal is complete.
- Do not execute free-form text, selectors, coordinates, JavaScript, or shell commands from Jev.

If validation fails, stop and reobserve. Do not silently retry with a modified answer.
