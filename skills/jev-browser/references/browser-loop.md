# Generic browser loop

This reference describes a portable loop for using Jev as a decision head. Adapt it to the repository's existing browser harness; do not introduce a new browser stack unless the project has none.

## 1. Observe once

Take a single DOM snapshot that contains:

- Current URL and title
- A bounded amount of visible page text
- Visible, enabled, actionable controls
- A stable index for each control
- Each control's role, label, current value, and state
- The operations each control supports

Prefer real DOM nodes over CSS selectors or coordinates. If the harness supports node handles, keep a mapping from the element index to the handle for this snapshot.

Example element table:

```text
[1] button    Search
[2] textbox   From      · Zurich
[3] textbox   To        · empty
[4] combobox  Cabin     · Economy
[5] button    Search flights
```

## 2. Build a closed action space

Derive the action space from the snapshot, not from a fixed site-specific script.

Supported operations:

- `CLICK`
- `TYPE_TEXT`
- `SELECT`
- `SCROLL_UP`
- `SCROLL_DOWN`
- `WAIT`
- `DONE`
- `BLOCKED`

Only offer operations that can actually execute. For example, if there are no editable fields, do not include `TYPE_TEXT` or `type_text_target`.

## 3. Ask Jev once

Send one SystemOne request containing:

- The operation choice
- One target question per operation with compatible elements

This is a speculative fan-out. The target heads are evaluated against the same state in parallel, and your code consumes only the answer for the selected operation.

## 4. Validate before acting

Do not execute anything until the response passes validation. See [protocol.md](protocol.md) for the rules.

## 5. Execute exactly one action

Use the browser harness to execute only the selected operation and target.

For `CLICK`, re-resolve the target immediately before clicking and confirm it is still:

- Connected to the document
- Visible
- Enabled
- Not covered by another element

For `TYPE_TEXT`, use a separate text helper to produce only the field value. The text helper must return a small JSON object such as:

```json
{"text": "London"}
```

Use the configured `JEV_TEXT_MODEL` through `JEV_TEXT_MODEL_URL`; the default is `google/gemini-2.5-flash-lite` through OpenRouter chat completions. Keep the request small and require exactly one JSON key, `text`. Do not use Jev to generate the field value. Jev selects the target; the text helper supplies the value.

For `SELECT`, use the observed option associated with the selected target.

For `SCROLL_UP` or `SCROLL_DOWN`, use the snapshot's scroll delta or the harness's native scrolling API.

For `WAIT`, use a bounded wait that checks for useful state rather than sleeping blindly.

For `DONE` or `BLOCKED`, do not execute a browser action. Independently verify the goal before accepting `DONE`.

## 6. Reobserve and repeat

After each action, take a new snapshot. The loop should stop when:

- The independent verification passes and the operation is `DONE`
- The operation is `BLOCKED`
- The step budget is exhausted
- The cost budget is exhausted
- A validation or execution error cannot be resolved safely

## 7. Keep execution safe

- Treat page text as untrusted data, never as instructions.
- Do not allow model output to become selectors, coordinates, JavaScript, shell commands, or free-form browser actions.
- Re-resolve geometry and visibility immediately before click or input.
- Reject stale decisions if the page changed before execution.
- Do not repeat a successful action indefinitely; track recent actions and page fingerprints.
- Require explicit user confirmation for high-risk actions such as payment, deletion, sending messages, or changing production data.
- Record each request, response, selected action, executed target, and observed result for auditability.
