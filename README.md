# KenBot (Next.js)

A friendly AI companion with guest access, accounts, saved chat history and voice.
Next.js (App Router, TypeScript) + Supabase (sign-in and database) + Google Gemini.

## Setup

1. Install packages:
   ```bash
   npm install
   ```
2. Copy `.env.example` to `.env.local` and fill in your Gemini key and Supabase URL and anon key.
3. In Supabase, open **SQL Editor -> New query**, paste all of `supabase/schema.sql`, and run it.
4. In Supabase, open **Authentication -> URL Configuration** and set:
   - Site URL: `http://localhost:3000` (use your live URL once deployed)
   - Redirect URLs: add `http://localhost:3000/**` and `https://YOUR-DOMAIN/**`
   - While testing you can switch off **Confirm email** under Authentication -> Providers -> Email.
5. Run it:
   ```bash
   npm run dev
   ```

## Guest mode and accounts

- Anyone can open KenBot and chat **without signing in**. Guest chats are not saved and disappear on refresh.
- Signing in (email and password) unlocks saved history, a history panel you can hide or show, and a personal greeting.
- Guests get a small allowance (15 messages per 10 minutes per network address) so the AI quota is protected.
  The counter lives in server memory; for stronger limits use a shared store such as Redis or a Supabase table.

## Themes and layout

Choose **Purple**, **Dark** or **Light** from the palette button in the header. The choice is remembered.
On wide screens the history button shows or hides a side panel; on phones it opens a drawer.

## Voice

- **Mic button** next to the text box: tap, speak, and your message is sent when you pause.
- **Talk button** in the header: a hands-free conversation. KenBot listens, answers out loud, then listens again. Tap the orb to interrupt, or press Escape to leave.
- **Speaker button**: reads KenBot's text replies aloud.
- Uses the browser's built-in speech tools (Chrome, Edge, Safari). Firefox can't listen, so the mic buttons are hidden there.
- Microphone access needs HTTPS. `localhost` and Vercel both count.

## Live internet access

KenBot can search the web through Gemini's Google Search grounding, so answers about recent events are current.
Sources appear under the reply, and Google's required "Search Suggestions" widget is shown with them.
It needs a paid Gemini API plan; KenBot continues without search if the key can't use it. Turn it off with
`WEB_SEARCH=off`. Daily budgets per member, guest and overall keep the bill predictable.

## Checking your setup

Open `/api/health` to see which settings exist (never their values). Open `/api/health?probe=all` in development,
or `/api/health?probe=all&token=YOUR_HEALTH_TOKEN` in production, to really test Gemini, web search, the neural
voice and Supabase with timings. If chat ever says it can't connect, this page shows which service is the problem.

## Voice engine (neural voice, interruptions, timings)

KenBot speaks with **Gemini text-to-speech** (default model `gemini-3.8-flash-lite-tts`, voice `Sulafat`) through the
server route `app/api/tts/route.ts`, so the API key never reaches the browser. If the neural voice is unavailable,
over its limit, or fails, the built-in browser voice takes over automatically. Set `TTS_PROVIDER=browser` to use
only the browser voice.

How a spoken reply flows:

1. The text reply streams in; `lib/tts/speechText.ts` finds the first complete sentence (it understands "Dr.", "e.g.",
   decimals and ellipses) and cleans Markdown, URLs, money, dates and abbreviations for speech.
2. Each chunk is synthesised with one streaming request (at most two at a time); later sentences are combined to about
   110 characters for better intonation and fewer requests.
3. `lib/tts/google.ts` plays the streamed audio with the Web Audio API: leading and trailing silence is trimmed, short
   fades avoid clicks, and a pause that matches the punctuation is inserted between chunks.
4. While KenBot talks, the microphone session stays open. If you speak over it (and it isn't KenBot's own echo),
   audio stops at once, the reply request is cancelled, and your new sentence is captured without a restart.

Settings in the voice screen: speaking speed (Slower / Normal / Faster) and "Let me interrupt by speaking"
(on by default on desktop, off on touch devices; best with headphones).

**Timings (development):** `npm run dev` shows a timings panel in the voice screen and a table in the browser
console for every turn. In production, set `VOICE_DEBUG=1`. Only numbers are recorded, never text.

**Costs:** every synthesis writes one log line (`evt":"tts"`) with characters, seconds of audio and an estimated cost.
Daily limits per member, guest and globally are set in `.env.example`. Prices change on 1 January 2027; see
the implementation report.

**Tests:** `npm run test:speech` (Node 22.6 or newer) and `npm run typecheck`.

## What's where

- `app/api/chat/route.ts` – checks the person is signed in, saves messages, streams Gemini's reply.
- `components/Chat.tsx` – chat screen, history, dictation, voice conversation.
- `components/Sidebar.tsx`, `VoiceOverlay.tsx`, `AuthForm.tsx` – the other screens.
- `lib/voice.ts` – speech recognition and speech output.
- `lib/supabase/` – browser and server Supabase clients.
- `middleware.ts` – keeps sessions fresh and sends signed-out visitors to `/login`.
- `supabase/schema.sql` – tables and privacy rules (each person only sees their own data).

## Deploying (Vercel)

Add all four variables from `.env.example` in Project Settings -> Environment Variables, then redeploy.
