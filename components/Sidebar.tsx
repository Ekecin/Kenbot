"use client";

import Link from "next/link";
import { CloseIcon, PlusIcon } from "@/components/icons";

export type ConversationItem = { id: string; title: string };

export default function Sidebar({
  conversations,
  activeId,
  open,
  guest,
  userName,
  email,
  onNew,
  onOpen,
  onDelete,
  onSignOut,
  onClose,
}: {
  conversations: ConversationItem[];
  activeId: string | null;
  open: boolean;
  guest: boolean;
  userName: string | null;
  email: string | null;
  onNew: () => void;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onSignOut: () => void;
  onClose: () => void;
}) {
  return (
    <>
      <aside className={`side${open ? " open" : ""}`} aria-label="Your chats">
        <div className="side-top">
          <button type="button" className="new-chat" onClick={onNew}>
            <PlusIcon /> New chat
          </button>
          <button
            type="button"
            className="icon-btn side-close"
            onClick={onClose}
            aria-label="Close menu"
          >
            <CloseIcon />
          </button>
        </div>

        {guest ? (
          <div className="side-guest">
            <p>
              <strong>You&apos;re in guest mode.</strong>
            </p>
            <p>
              Guests can chat freely, but conversations aren&apos;t saved. Sign in to keep your
              history and pick it up on any device.
            </p>
            <Link href="/login" className="btn-primary">
              Sign in or create account
            </Link>
          </div>
        ) : (
          <nav className="conv-list" aria-label="Past conversations">
            {conversations.length === 0 ? (
              <p className="side-empty">
                Your conversations will show up here, ready whenever you want to continue them.
              </p>
            ) : (
              conversations.map((c) => (
                <div key={c.id} className={`conv${c.id === activeId ? " active" : ""}`}>
                  <button
                    type="button"
                    className="conv-title"
                    onClick={() => onOpen(c.id)}
                    aria-current={c.id === activeId ? "true" : undefined}
                    title={c.title}
                  >
                    {c.title}
                  </button>
                  <button
                    type="button"
                    className="conv-del"
                    onClick={() => onDelete(c.id)}
                    aria-label={`Delete chat: ${c.title}`}
                  >
                    <CloseIcon size={14} />
                  </button>
                </div>
              ))
            )}
          </nav>
        )}

        <div className="user-card">
          <div className="user-initial" aria-hidden="true">
            {(userName ?? "G").charAt(0).toUpperCase()}
          </div>
          <div className="user-meta">
            <strong>{userName ?? "Guest"}</strong>
            <span>{email ?? "Not signed in"}</span>
          </div>
          {guest ? (
            <Link href="/login" className="ghost">
              Sign in
            </Link>
          ) : (
            <button type="button" className="ghost" onClick={onSignOut}>
              Sign out
            </button>
          )}
        </div>
      </aside>
      {open && <button type="button" className="scrim" onClick={onClose} aria-label="Close menu" />}
    </>
  );
}
