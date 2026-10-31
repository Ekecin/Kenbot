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


### Gemini response length and model

The chat route uses `gemini-3.8-flash` by default and allows up to 16,384 output
tokens for regular text replies (voice replies remain shorter). If you set
`GEMINI_MODEL` in your hosting provider, use `gemini-3.8-flash` or remove the
variable to use the default. After changing environment variables, redeploy
the application. The route streams complete Gemini SSE events and flushes the
final decoder buffer so the last part of a reply is not dropped.
