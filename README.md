# Interview Practice

A small local app for rehearsing spoken job interviews. Paste a job spec, get a question plan, then answer out loud. The interviewer speaks each question, listens until you press **Space**, and decides whether to follow up or move on. At the end you can ask for feedback.

## Run it

Needs Node 18 or newer. No `npm install`.

```bash
cp .env.example .env     # then add your keys
npm run dev              # or: node server.js
```

`npm run dev` restarts the server whenever `server.js` changes (Node's built-in `--watch`), and open pages reload whenever anything in `public/` changes. A page won't reload mid-interview or while questions are generating; it shows "Update ready" and reloads when you go back to setup. `.env` changes never need a restart.

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
- The interviewer appears as a simple line-drawn face in a video-call tile: it talks while speaking, glances away while thinking and nods while you answer.
- Transcript lines are collapsed so you listen rather than read; click a line, or **Show all text**, to read them.
- No sound? Use **Settings → Test voice**. If the browser blocks audio, a **Play question** button appears.
- **Space** while you're answering: finish your answer.
- **Space** while the interviewer is talking: skip to answering.
- **Get feedback** under any of your answers: a high-quality model compares the answer with the question (and its follow-ups), then shows what worked, what was missing, the missing details explained, a stronger version of the answer, and a delivery tip. Takes up to a minute. Saved with the session.
- **End interview** stops at any point; **Overall feedback** reviews the whole transcript, also with the high-quality model.
- Questions are collapsed under short topic labels; click one to see the question.
- Your job spec, questions, transcript and feedback are saved in the browser (localStorage) and survive a refresh. If you refresh mid-interview, press **Resume** to carry on from the last question. **Settings → Reset all data** clears it all (keys and provider settings are kept).

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

| Feedback (Claude / Grok) | `claude-opus-5-5` / `grok-4.7`, effort `high` |

If interviewer replies feel slow, try `claude-haiku-5-5`. Feedback uses its own model setting, so the interviewer stays fast while feedback stays thorough; for the deepest feedback try `claude-fable-5-1` (slower and pricier).
