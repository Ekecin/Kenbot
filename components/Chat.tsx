"use client";

import Image from "next/image";
import {
  FormEvent,
  KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import ReactMarkdown from "react-markdown";

type Msg = {
  id: string;
  role: "user" | "bot";
  text: string;
  error?: boolean;
};

const SUGGESTIONS = [
  { label: "Explain it simply", prompt: "Can you explain something to me in simple terms? I'll tell you what." },
  { label: "Plan my day", prompt: "Help me plan a calm, productive day." },
  { label: "Encourage me", prompt: "I could use a little encouragement today." },
  { label: "Project ideas", prompt: "Give me a fun project idea I can start this week." },
];

const uid = () => Math.random().toString(36).slice(2, 10);

function friendlyError(code?: string): string {
  switch (code) {
    case "missing_key":
    case "auth":
      return "I'm not connected to my AI brain yet. Add a valid GEMINI_API_KEY to .env.local and restart the dev server.";
    case "rate_limited":
      return "I'm getting a lot of questions at once! Give me a few seconds, then try again. 💜";
    default:
      return "I couldn't reach my thinking cap just now. Check your connection and send that again — I'll be right here.";
  }
}

function BotAvatar() {
  return (
    <div className="avatar sm">
      <Image src="/avatar.webp" alt="" width={32} height={32} />
    </div>
  );
}

export default function Chat() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);

  const messagesRef = useRef<Msg[]>([]);
  messagesRef.current = messages;
  const abortRef = useRef<AbortController | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const stickRef = useRef(true);

  const send = useCallback(async (raw: string) => {
    const text = raw.trim();
    if (!text || abortRef.current) return;

    const userMsg: Msg = { id: uid(), role: "user", text };
    const botId = uid();
    const history = [...messagesRef.current, userMsg]
      .filter((m) => !m.error && m.text)
      .slice(-20)
      .map((m) => ({ role: m.role === "user" ? "user" : "model", text: m.text }));

    setMessages((p) => [...p, userMsg, { id: botId, role: "bot", text: "" }]);
    setInput("");
    setBusy(true);
    stickRef.current = true;

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const patch = (fn: (m: Msg) => Msg) =>
      setMessages((p) => p.map((m) => (m.id === botId ? fn(m) : m)));

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history }),
        signal: ctrl.signal,
      });

      if (!res.ok || !res.body) {
        let code: string | undefined;
        try {
          code = (await res.json()).error;
        } catch {}
        patch((m) => ({ ...m, text: friendlyError(code), error: true }));
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let acc = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        acc += decoder.decode(value, { stream: true });
        const snapshot = acc;
        patch((m) => ({ ...m, text: snapshot }));
      }
      if (!acc.trim()) {
        patch((m) => ({
          ...m,
          text: "Hmm, I came up empty on that one. Could you try rephrasing it for me?",
          error: true,
        }));
      }
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        patch((m) =>
          m.text
            ? m
            : { ...m, text: "No problem, I stopped. Ask me anything whenever you're ready. 💜", error: true },
        );
      } else {
        patch((m) => ({ ...m, text: friendlyError("network"), error: true }));
      }
    } finally {
      abortRef.current = null;
      setBusy(false);
      inputRef.current?.focus();
    }
  }, []);

  const stop = () => abortRef.current?.abort();

  const reset = () => {
    abortRef.current?.abort();
    setMessages([]);
    setInput("");
    inputRef.current?.focus();
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (busy) return stop();
    void send(input);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
    // On phones and tablets Enter adds a new line; the Send button sends.
    if (window.matchMedia("(pointer: coarse)").matches) return;
    e.preventDefault();
    void send(input);
  };

  // Grow the textarea with its content, up to a limit.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

  // Keep the latest message in view unless the visitor scrolled up to read.
  useEffect(() => {
    const el = logRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const onScroll = () => {
    const el = logRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };

  const empty = messages.length === 0;

  return (
    <main className="shell">
      <section className="chat" aria-label="Chat with KenBot">
        <header className="head">
          <div className="avatar">
            <Image src="/avatar.webp" alt="" width={46} height={46} priority />
            <span className="dot" aria-hidden="true" />
          </div>
          <div className="who">
            <h1>KenBot</h1>
            <p>Online · happy to help</p>
          </div>
          <button type="button" className="ghost" onClick={reset} disabled={empty}>
            New chat
          </button>
        </header>

        <div
          className="log"
          ref={logRef}
          onScroll={onScroll}
          role="log"
          aria-live="polite"
          aria-busy={busy}
        >
          {empty && (
            <div className="banner">
              <Image
                src="/banner.webp"
                alt=""
                fill
                priority
                sizes="(max-width: 800px) 100vw, 780px"
              />
              <p>Ask anything. We'll work it out together.</p>
            </div>
          )}

          <div className="row bot">
            <BotAvatar />
            <div className="bubble">
              Hi there! 👋 I'm KenBot, and I'm really glad you're here. Ask me
              anything, big or small, and we'll figure it out together.
            </div>
          </div>

          {messages.map((m) =>
            m.role === "user" ? (
              <div className="row user" key={m.id}>
                <div className="bubble">{m.text}</div>
              </div>
            ) : (
              <div className="row bot" key={m.id}>
                <BotAvatar />
                <div className={`bubble${m.error ? " soft-error" : ""}`}>
                  {m.text ? (
                    <div className="md">
                      <ReactMarkdown
                        components={{
                          a: ({ href, children }) => (
                            <a href={href} target="_blank" rel="noopener noreferrer">
                              {children}
                            </a>
                          ),
                        }}
                      >
                        {m.text}
                      </ReactMarkdown>
                    </div>
                  ) : (
                    <span className="typing" role="status" aria-label="KenBot is thinking">
                      <i />
                      <i />
                      <i />
                    </span>
                  )}
                </div>
              </div>
            ),
          )}

          {empty && (
            <div className="chips">
              {SUGGESTIONS.map((s) => (
                <button type="button" key={s.label} onClick={() => void send(s.prompt)}>
                  {s.label}
                </button>
              ))}
            </div>
          )}
        </div>

        <form className="composer" onSubmit={onSubmit}>
          <div className="composer-row">
            <div className="field">
              <textarea
                ref={inputRef}
                rows={1}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder="Tell KenBot what's on your mind…"
                aria-label="Your message"
                enterKeyHint="send"
                autoComplete="off"
              />
            </div>
            <button
              type="submit"
              className={`send${busy ? " stop" : ""}`}
              disabled={!busy && !input.trim()}
              aria-label={busy ? "Stop reply" : "Send message"}
            >
              {busy ? (
                <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                  <rect x="3" y="3" width="10" height="10" rx="2" fill="currentColor" />
                </svg>
              ) : (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path
                    d="M12 19V5m0 0-6 6m6-6 6 6"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
            </button>
          </div>
          <p className="hint">Enter to send · Shift + Enter for a new line</p>
        </form>
      </section>
    </main>
  );
}
