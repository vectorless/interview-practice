# Interview Practice

A small local app for rehearsing spoken job interviews. Paste a job spec, get a question plan, then answer out loud. The interviewer speaks each question, listens until you press **Space**, and decides whether to follow up or move on. At the end you can ask for feedback.

## Run it

Needs Node 18 or newer. No `npm install`.

```bash
cp .env.example .env     # then add your keys
node server.js
```

Open http://localhost:3456 in Chrome or Edge (best mic/speech support).

## Keys

Put whichever keys you have in `.env`:

| Variable | Used for |
|---|---|
| `ANTHROPIC_API_KEY` | Inference (Claude) |
| `ANTHROPIC_WORKSPACE_ID` | Only for organisation-level Anthropic keys not scoped to a workspace (`wrkspc_…`) |
| `ELEVENLABS_API_KEY` | Speech-to-text and text-to-speech |
| `XAI_API_KEY` | Inference, STT and TTS (Grok) |

`.env` is re-read on every request, so you can edit it without restarting. Keys never reach the browser. The server only listens on `127.0.0.1`.

You can also start with no speech keys at all: the **Browser** STT/TTS options are free (browser STT works in Chrome/Edge/Safari, not Firefox).

## Using it

- **Job spec**: paste it, click **Upload PDF**, or drop a PDF/text file onto the box. Text is extracted in the browser (pdf.js, loaded from jsDelivr on first use) and shown so you can tidy it before generating. Scanned PDFs with no text layer can't be read; copy the text in instead.
- **Settings**: pick a provider for inference, STT and TTS. Options without a key are disabled. Model names, effort and voices are under *Models and voices*. These choices are saved to `config.json`.
- **Space** while you're answering: finish your answer.
- **Space** while the interviewer is talking: skip to answering.
- **End interview** stops at any point; **Get feedback** reviews the transcript.

## Files

- `server.js` — static server plus `/api/chat`, `/api/stt`, `/api/tts`, `/api/config`; holds the provider calls.
- `public/prompts.js` — all prompt text (question plan, interviewer behaviour, feedback). Edit this to tune the interview.
- `public/app.js` — UI, recording, interview loop.

## Defaults

| Setting | Default |
|---|---|
| Claude model | `claude-sonnet-5-5`, effort `low` (keeps turns quick) |
| Grok model | `grok-4.7`, reasoning effort `low` |
| ElevenLabs TTS | `eleven_multilingual_v2`, voice `JBFqnCBsd6RMkjVDRZzb` |
| ElevenLabs STT | `scribe_v2` |
| Grok TTS / STT | voice `rex` / `grok-voice-transcribe-2.0` |

If interviewer replies feel slow, try `claude-haiku-5-5`. For richer feedback, raise effort to `medium`.
