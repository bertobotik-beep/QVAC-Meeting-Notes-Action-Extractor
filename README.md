# QVAC Meeting Notes Action Extractor

Paste raw meeting notes and an on-device AI extracts a clean list of action items (with the owner if mentioned), grounded only in what was actually said. No cloud call, no API key.

## Run

```bash
npm install
npm start
```

Then open http://localhost:31014

Requires Node.js >= 22.17 (see `engines` in `package.json`).

## QVAC SDK version

`@qvac/sdk` ^0.19.0 (see `package.json`).

## How it works

Built on [Tether's QVAC SDK](https://www.npmjs.com/package/@qvac/sdk) — all inference runs on-device, no cloud call, no API key.

1. `loadModel({ modelSrc: LLAMA_3_2_1B_INST_Q4_0 })` loads the model once at startup, before the HTTP server starts accepting requests.
2. Each `POST /api/actionitems` request calls `extract()`, which runs `completion()` with *two* one-shot examples baked into the chat history: one showing several real action items being pulled out of messy notes, and one showing the "nothing to extract" case for a casual recap with no assigned task. Both are real user/assistant turns, not prose instructions, and the reply streams token-by-token via `run.tokenStream`.
3. `unloadModel({ modelId })` releases the model on `SIGINT`/`SIGTERM`.

The response in `src/actionitems.js` then goes through several deterministic filters before reaching the UI: bullets that are just a negation/recap ("no decisions made") are dropped, bullets that rephrase a past-tense discussion topic ("talked about the offsite") as if it were a future task are dropped, and bullets that borrow a deadline/owner from an unrelated "this is final" decision sentence are dropped too. If nothing survives, the UI shows "No action items found in the notes." rather than a fabricated task.

### Example

Input:

> quick sync on the launch. we agreed the landing page copy is final. priya will update the pricing table by friday. still need someone to test the checkout flow on mobile before we ship. jordan is going to send the press release draft to the team tomorrow.

Output:

```
- Update the pricing table by Friday (Priya)
- Test the checkout flow on mobile before shipping
- Send the press release draft to the team tomorrow (Jordan)
```

This exact pair (plus the "no action items" counter-example) is baked into the prompt as `EXAMPLE_NOTES`/`EXAMPLE_OUTPUT` and `EXAMPLE_NOTES_2`/`EXAMPLE_OUTPUT_2` in `src/actionitems.js`.

## License

MIT
