"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  FormEvent,
  KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import ReactMarkdown from "react-markdown";
import { createClient } from "@/lib/supabase/client";
import {
  cleanForSpeech,
  createListener,
  createSpeaker,
  voiceErrorMessage,
  voiceInputSupported,
  voiceOutputSupported,
  type Listener,
  type Speaker,
} from "@/lib/voice";
import Sidebar, { type ConversationItem } from "@/components/Sidebar";
import VoiceOverlay, { type VoiceState } from "@/components/VoiceOverlay";
import ThemeMenu, { type Theme } from "@/components/ThemeMenu";
import { HistoryIcon, MicIcon, SpeakerIcon, WaveIcon } from "@/components/icons";

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
const isTouch = () =>
  typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;
// On narrow screens the history panel is a slide-over drawer instead of a side panel.
const isDrawer = () =>
  typeof window !== "undefined" && window.matchMedia("(max-width: 899px)").matches;

function friendlyError(code?: string): string {
  switch (code) {
    case "missing_key":
    case "auth":
      return "I'm not connected to my AI brain yet. Add a valid GEMINI_API_KEY to your environment variables and restart.";
    case "missing_supabase":
      return "I can't reach the sign-in service yet. Check your Supabase environment variables and restart.";
    case "unauthorized":
      return "Your session has ended. Please sign in again and we'll pick up where we left off.";
    case "model_not_found":
      return "I can't find the AI model I'm set to use. Check GEMINI_MODEL in your environment variables (for example try gemini-flash-latest) and restart.";
    case "overloaded":
      return "My AI brain is very busy right now. Please try again in a moment. 💜";
    case "server_error":
      return "Something went wrong on my side. Please try again, and if it keeps happening, check the server logs.";
    case "guest_limit":
      return "You've reached the guest limit for now. Sign in (it's free) to keep chatting and to save your history. 💜";
    case "rate_limited":
      return "I'm getting a lot of questions at once! Give me a few seconds, then try again. 💜";
    default:
      return "I couldn't reach my thinking cap just now. Check your connection and send that again. I'll be right here.";
  }
}

function BotAvatar() {
  return (
    <div className="avatar sm">
      <Image src="/avatar.webp" alt="" width={32} height={32} />
    </div>
  );
}

export default function Chat({
  userName,
  email,
}: {
  userName: string | null;
  email: string | null;
}) {
  // Visitors without an account are guests: they can chat, but nothing is saved.
  const isGuest = userName === null;
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);

  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [conversations, setConversations] = useState<ConversationItem[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [theme, setTheme] = useState<Theme>("purple");

  const [canListen, setCanListen] = useState(false);
  const [canSpeak, setCanSpeak] = useState(false);
  const [speakReplies, setSpeakReplies] = useState(false);
  const [dictating, setDictating] = useState(false);
  const [voiceMode, setVoiceMode] = useState(false);
  const [voiceState, setVoiceState] = useState<VoiceState>("listening");
  const [interim, setInterim] = useState("");

  const messagesRef = useRef<Msg[]>([]);
  messagesRef.current = messages;
  const speakRepliesRef = useRef(false);
  speakRepliesRef.current = speakReplies;

  const abortRef = useRef<AbortController | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const stickRef = useRef(true);
  const convIdRef = useRef<string | null>(null);
  const listenerRef = useRef<Listener | null>(null);
  const speakerRef = useRef<Speaker | null>(null);
  const voiceModeRef = useRef(false);
  const listenLoopRef = useRef<() => void>(() => {});
  const gotFinalRef = useRef(false);
  const silentRef = useRef(0);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* ───────── Setup ───────── */

  useEffect(() => {
    setCanListen(voiceInputSupported());
    setCanSpeak(voiceOutputSupported());
    speakerRef.current = createSpeaker({
      onStart: () => {
        if (voiceModeRef.current) setVoiceState("speaking");
      },
    });
    try {
      setSpeakReplies(localStorage.getItem("kenbot:speak") === "1");
    } catch {
      // Storage can be unavailable; the default is fine.
    }
    const current = document.documentElement.dataset.theme;
    if (current === "purple" || current === "dark" || current === "light") setTheme(current);
    try {
      // On wide screens, remember whether the person left the history panel open.
      if (!isDrawer() && localStorage.getItem("kenbot:history") === "1") setSidebarOpen(true);
    } catch {
      // Not critical.
    }
    return () => {
      speakerRef.current?.cancel();
      listenerRef.current?.abort();
    };
  }, []);

  const showNotice = useCallback((msg: string) => {
    setNotice(msg);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 6000);
  }, []);

  const refreshList = useCallback(async () => {
    if (isGuest) return;
    const { data, error } = await supabase
      .from("conversations")
      .select("id,title")
      .order("updated_at", { ascending: false })
      .limit(50);
    if (error) {
      console.warn("Couldn't load your chats:", error.message);
      return;
    }
    setConversations((data ?? []) as ConversationItem[]);
  }, [supabase, isGuest]);

  useEffect(() => {
    void refreshList();
  }, [refreshList]);

  /* ───────── Voice: leaving, errors ───────── */

  const exitVoice = useCallback(
    (message?: string) => {
      voiceModeRef.current = false;
      setVoiceMode(false);
      silentRef.current = 0;
      listenerRef.current?.abort();
      speakerRef.current?.cancel();
      abortRef.current?.abort();
      if (message) showNotice(message);
    },
    [showNotice],
  );

  const handleVoiceError = useCallback(
    (code: string, inConversation: boolean) => {
      const msg = voiceErrorMessage(code, inConversation ? "conversation" : "dictation");
      if (!msg) return;
      if (inConversation) exitVoice(msg);
      else showNotice(msg);
    },
    [exitVoice, showNotice],
  );

  /* ───────── Sending a message ───────── */

  const send = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text || abortRef.current) return;

      const inVoice = voiceModeRef.current;
      const speak = inVoice || speakRepliesRef.current;
      const speaker = speakerRef.current;
      if (speak) speaker?.cancel();

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

      let finalText = "";
      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: history,
            conversationId: convIdRef.current,
            voice: inVoice,
          }),
          signal: ctrl.signal,
        });

        if (!isGuest && res.headers.get("X-Guest") === "1") {
          showNotice("Your session has ended, so this chat wasn't saved. Please sign in again to keep your history.");
        }
        const cid = res.headers.get("X-Conversation-Id");
        if (cid && cid !== convIdRef.current) {
          convIdRef.current = cid;
          setActiveId(cid);
        }

        if (!res.ok || !res.body) {
          let code: string | undefined;
          try {
            code = (await res.json()).error;
          } catch {}
          finalText = friendlyError(code);
          patch((m) => ({ ...m, text: finalText, error: true }));
          if (res.status === 401) router.replace("/login");
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
          if (speak) speaker?.feed(snapshot);
        }
        acc += decoder.decode();
        if (acc.trim()) {
          const snapshot = acc;
          patch((m) => ({ ...m, text: snapshot }));
        }
        if (!acc.trim()) {
          finalText = "Hmm, I came up empty on that one. Could you try rephrasing it for me?";
          patch((m) => ({ ...m, text: finalText, error: true }));
        } else {
          finalText = acc;
        }
      } catch (e) {
        if ((e as Error).name === "AbortError") {
          finalText = "";
          patch((m) =>
            m.text
              ? m
              : { ...m, text: "No problem, I stopped. Ask me anything whenever you're ready. 💜", error: true },
          );
        } else {
          finalText = friendlyError("network");
          patch((m) => ({ ...m, text: finalText, error: true }));
        }
      } finally {
        abortRef.current = null;
        setBusy(false);
        void refreshList();

        const next = () => {
          if (voiceModeRef.current) listenLoopRef.current();
          else if (!isTouch()) inputRef.current?.focus();
        };
        if (speak && speaker && finalText.trim()) {
          speaker.feed(finalText);
          speaker.end(next);
        } else {
          next();
        }
      }
    },
    [refreshList, router, isGuest, showNotice],
  );

  const stop = () => {
    speakerRef.current?.cancel();
    abortRef.current?.abort();
  };

  /* ───────── Voice conversation (hands-free loop) ───────── */

  const listenInVoiceMode = useCallback(() => {
    if (!voiceModeRef.current) return;
    listenerRef.current?.abort();
    gotFinalRef.current = false;
    setVoiceState("listening");
    setInterim("");

    const listener = createListener({
      onInterim: (t) => setInterim(t),
      onFinal: (t) => {
        gotFinalRef.current = true;
        silentRef.current = 0;
        setInterim(t);
        setVoiceState("thinking");
        void send(t);
      },
      onEnd: () => {
        if (!voiceModeRef.current || gotFinalRef.current) return;
        // Nothing was said. Try again, but close the mic after a few quiet rounds.
        silentRef.current += 1;
        if (silentRef.current >= 3) {
          exitVoice("I didn't hear anything, so I closed the mic. Tap Talk whenever you'd like to continue.");
          return;
        }
        setTimeout(() => listenLoopRef.current(), 250);
      },
      onError: (code) => handleVoiceError(code, true),
    });
    listenerRef.current = listener;
    try {
      listener?.start();
    } catch {
      // Already started.
    }
  }, [send, exitVoice, handleVoiceError]);

  useEffect(() => {
    listenLoopRef.current = listenInVoiceMode;
  }, [listenInVoiceMode]);

  const startVoiceMode = () => {
    if (!canListen) {
      showNotice("Voice isn't supported in this browser. Try Chrome, Edge or Safari.");
      return;
    }
    listenerRef.current?.abort();
    setDictating(false);
    speakerRef.current?.unlock();
    voiceModeRef.current = true;
    silentRef.current = 0;
    setVoiceMode(true);
    listenInVoiceMode();
  };

  const onOrb = () => {
    if (voiceState === "listening") {
      listenerRef.current?.stop();
      return;
    }
    speakerRef.current?.cancel();
    if (abortRef.current) abortRef.current.abort();
    else listenInVoiceMode();
  };

  const closeVoice = useCallback(() => exitVoice(), [exitVoice]);

  /* ───────── Dictation (tap the mic, speak, it sends) ───────── */

  const toggleDictation = () => {
    if (dictating) {
      listenerRef.current?.stop();
      return;
    }
    if (!canListen) {
      showNotice("Voice isn't supported in this browser. Try Chrome, Edge or Safari.");
      return;
    }
    if (abortRef.current) return;

    listenerRef.current?.abort();
    const prefix = input.trim();
    gotFinalRef.current = false;

    const listener = createListener({
      onInterim: (t) => setInput(prefix ? `${prefix} ${t}` : t),
      onFinal: (t) => {
        gotFinalRef.current = true;
        setDictating(false);
        void send(prefix ? `${prefix} ${t}` : t);
      },
      onEnd: () => {
        setDictating(false);
        if (!gotFinalRef.current) setInput(prefix);
      },
      onError: (code) => handleVoiceError(code, false),
    });
    listenerRef.current = listener;
    setDictating(true);
    try {
      listener?.start();
    } catch {
      setDictating(false);
    }
  };

  const toggleSpeak = () => {
    const next = !speakReplies;
    setSpeakReplies(next);
    if (next) speakerRef.current?.unlock();
    else speakerRef.current?.cancel();
    try {
      localStorage.setItem("kenbot:speak", next ? "1" : "0");
    } catch {
      // Not critical.
    }
  };

  /* ───────── Theme and history panel ───────── */

  const changeTheme = (next: Theme) => {
    setTheme(next);
    document.documentElement.dataset.theme = next;
    const color = next === "light" ? "#eceefa" : next === "dark" ? "#06070a" : "#04050d";
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", color);
    try {
      localStorage.setItem("kenbot:theme", next);
    } catch {
      // Not critical.
    }
  };

  const toggleHistory = () => {
    const next = !sidebarOpen;
    setSidebarOpen(next);
    if (!isDrawer()) {
      try {
        localStorage.setItem("kenbot:history", next ? "1" : "0");
      } catch {
        // Not critical.
      }
    }
  };

  /* ───────── Conversations ───────── */

  const reset = useCallback(() => {
    abortRef.current?.abort();
    speakerRef.current?.cancel();
    listenerRef.current?.abort();
    setDictating(false);
    setMessages([]);
    setInput("");
    convIdRef.current = null;
    setActiveId(null);
    if (isDrawer()) setSidebarOpen(false);
    if (!isTouch()) inputRef.current?.focus();
  }, []);

  const openConversation = async (id: string) => {
    abortRef.current?.abort();
    speakerRef.current?.cancel();
    listenerRef.current?.abort();
    setDictating(false);
    const { data, error } = await supabase
      .from("messages")
      .select("id,role,content")
      .eq("conversation_id", id)
      .order("created_at", { ascending: true });
    if (error) {
      showNotice("I couldn't open that chat just now. Please try again.");
      return;
    }
    setMessages(
      (data ?? []).map((m: { id: string; role: string; content: string }) => ({
        id: m.id,
        role: (m.role === "user" ? "user" : "bot") as Msg["role"],
        text: m.content,
      })),
    );
    convIdRef.current = id;
    setActiveId(id);
    stickRef.current = true;
    if (isDrawer()) setSidebarOpen(false);
  };

  const deleteConversation = async (id: string) => {
    if (!window.confirm("Delete this chat? This can't be undone.")) return;
    const { error } = await supabase.from("conversations").delete().eq("id", id);
    if (error) {
      showNotice("I couldn't delete that chat. Please try again.");
      return;
    }
    setConversations((list) => list.filter((c) => c.id !== id));
    if (convIdRef.current === id) reset();
  };

  const signOut = async () => {
    exitVoice();
    await supabase.auth.signOut();
    router.replace("/login");
    router.refresh();
  };

  /* ───────── Input handling ───────── */

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (busy) return stop();
    void send(input);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
    // On phones and tablets Enter adds a new line; the Send button sends.
    if (isTouch()) return;
    e.preventDefault();
    void send(input);
  };

  // Grow the textarea with its content, up to a limit.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    const full = el.scrollHeight;
    el.style.height = `${Math.min(full, 160)}px`;
    // Only show a scrollbar once the text is taller than the box.
    el.style.overflowY = full > 160 ? "auto" : "hidden";
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

  const lastUser = [...messages].reverse().find((m) => m.role === "user")?.text ?? "";
  const lastBot = [...messages].reverse().find((m) => m.role === "bot")?.text ?? "";
  const caption =
    voiceState === "listening"
      ? interim || "Go ahead, I'm listening…"
      : voiceState === "thinking"
        ? lastUser
        : cleanForSpeech(lastBot).slice(0, 240);

  return (
    <main className="shell">
      <div className="app">
        <Sidebar
          conversations={conversations}
          activeId={activeId}
          open={sidebarOpen}
          guest={isGuest}
          userName={userName}
          email={email}
          onNew={reset}
          onOpen={(id) => void openConversation(id)}
          onDelete={(id) => void deleteConversation(id)}
          onSignOut={() => void signOut()}
          onClose={() => setSidebarOpen(false)}
        />

        <section className="chat" aria-label="Chat with KenBot">
          <header className="head">
            <button
              type="button"
              className={`icon-btn${sidebarOpen ? " on" : ""}`}
              onClick={toggleHistory}
              aria-pressed={sidebarOpen}
              aria-label={sidebarOpen ? "Hide chat history" : "Show chat history"}
              title={sidebarOpen ? "Hide chat history" : "Show chat history"}
            >
              <HistoryIcon />
            </button>
            <div className="avatar">
              <Image src="/avatar.webp" alt="" width={46} height={46} priority />
              <span className="dot" aria-hidden="true" />
            </div>
            <div className="who">
              <h1>KenBot</h1>
              <p>Online · happy to help</p>
            </div>
            <ThemeMenu theme={theme} onChange={changeTheme} />
            {canSpeak && (
              <button
                type="button"
                className={`icon-btn${speakReplies ? " on" : ""}`}
                onClick={toggleSpeak}
                aria-pressed={speakReplies}
                aria-label="Read replies aloud"
                title="Read replies aloud"
              >
                <SpeakerIcon />
              </button>
            )}
            {canListen && (
              <button
                type="button"
                className="talk"
                onClick={startVoiceMode}
                aria-label="Start a voice conversation"
              >
                <WaveIcon />
                <span>Talk</span>
              </button>
            )}
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
                <p>Ask anything. We&apos;ll work it out together.</p>
              </div>
            )}

            {isGuest && (
              <div className="guest-note">
                <span>You&apos;re chatting as a guest, so this conversation won&apos;t be saved.</span>
                <Link href="/login">Sign in to keep your history</Link>
              </div>
            )}

            <div className="row bot">
              <BotAvatar />
              <div className="bubble">
                Hi {userName ?? "there"}! 👋 I&apos;m KenBot, and I&apos;m really glad you&apos;re here. Ask me
                anything, big or small, and we&apos;ll figure it out together.
                {canListen && " You can also tap Talk and we can chat out loud."}
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
            {notice && (
              <p className="notice" role="status">
                {notice}
              </p>
            )}
            <div className="composer-row">
              <div className="field">
                <textarea
                  ref={inputRef}
                  rows={1}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={onKeyDown}
                  placeholder={dictating ? "Listening… go ahead and speak" : "Tell KenBot what's on your mind…"}
                  aria-label="Your message"
                  enterKeyHint="send"
                  autoComplete="off"
                />
              </div>
              {canListen && (
                <button
                  type="button"
                  className={`mic${dictating ? " on" : ""}`}
                  onClick={toggleDictation}
                  aria-pressed={dictating}
                  aria-label={dictating ? "Stop listening" : "Speak your message"}
                  title={dictating ? "Stop listening" : "Speak your message"}
                >
                  <MicIcon />
                </button>
              )}
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
      </div>

      {voiceMode && (
        <VoiceOverlay state={voiceState} caption={caption} onOrb={onOrb} onClose={closeVoice} />
      )}
    </main>
  );
}
