# KenBot (Next.js)

A friendly AI chat companion, converted from plain HTML/CSS/JS to Next.js (App Router, TypeScript).

## Run it

```bash
npm install
cp .env.example .env.local   # then put your own Gemini key inside
npm run dev
```

Open http://localhost:3000

## What's where

- `app/api/chat/route.ts` – server route. Holds the API key, sets KenBot's kind personality, streams replies.
- `components/Chat.tsx` – the chat interface.
- `app/globals.css` – all styling and animation.
- `public/` – optimised planet, avatar and banner images.

## Deploying

Add `GEMINI_API_KEY` (and optionally `GEMINI_MODEL`) as environment variables on your host, for example Vercel.
Never commit `.env.local`.
