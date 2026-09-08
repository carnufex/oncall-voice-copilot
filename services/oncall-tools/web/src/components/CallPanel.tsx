import { ConversationProvider, useConversation } from "@elevenlabs/react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { startSessionForIncident, reportConversationId } from "../api.js";

type TranscriptTurn = { id: number; source: "ai" | "user"; message: string };
type SessionMode = "voice" | "text";

function CallPanelInner({ incidentId, onConversationId }: { incidentId: string; onConversationId: (id: string) => void }) {
  const [transcript, setTranscript] = useState<TranscriptTurn[]>([]);
  const [errorText, setErrorText] = useState<string | undefined>(undefined);
  const [starting, setStarting] = useState(false);
  const [mode, setMode] = useState<SessionMode>("voice");
  const [draft, setDraft] = useState("");
  const nextId = useRef(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const conversation = useConversation({
    onConnect: ({ conversationId }) => {
      void reportConversationId(incidentId, conversationId);
      onConversationId(conversationId);
    },
    onMessage: ({ message, source }) => {
      setTranscript((t) => [...t, { id: nextId.current++, source, message }]);
    },
    onError: (message) => setErrorText(message),
  });

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [transcript]);

  const connected = conversation.status === "connected";

  useEffect(() => {
    if (connected && mode === "text") inputRef.current?.focus();
  }, [connected, mode]);

  async function handleAnswer() {
    setErrorText(undefined);
    setStarting(true);
    try {
      const session = await startSessionForIncident(incidentId, mode);
      if (mode === "text") {
        // Text rehearsal mode: same agent, same tools, no audio (no TTS/ASR spend).
        await conversation.startSession({
          signedUrl: session.signed_url!,
          connectionType: "websocket",
          textOnly: true,
          overrides: { conversation: { textOnly: true } },
          dynamicVariables: session.dynamic_variables,
        });
      } else {
        await conversation.startSession({
          conversationToken: session.conversation_token!,
          connectionType: "webrtc",
          dynamicVariables: session.dynamic_variables,
        });
      }
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : "Failed to start the call");
    } finally {
      setStarting(false);
    }
  }

  async function handleHangUp() {
    await conversation.endSession();
  }

  function handleSend(e: FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || !connected) return;
    conversation.sendUserMessage(text);
    setTranscript((t) => [...t, { id: nextId.current++, source: "user", message: text }]);
    setDraft("");
  }

  const statusKey = connected ? (mode === "text" ? "connected" : conversation.mode) : conversation.status;
  const statusLabel = connected ? (mode === "text" ? "connected (text)" : conversation.mode) : conversation.status;
  const busy = starting || conversation.status === "connecting";

  return (
    <div className="call-panel">
      <div className="call-panel-controls">
        {!connected ? (
          <button className="answer-button" onClick={handleAnswer} disabled={busy}>
            {busy ? "Connecting…" : mode === "voice" ? "Answer call" : "Start text session"}
          </button>
        ) : (
          <button className="hangup-button" onClick={handleHangUp}>
            {mode === "voice" ? "Hang up" : "End session"}
          </button>
        )}
        <div className={`call-status call-status-${statusKey}`}>
          <span className="call-status-dot" />
          {statusLabel}
        </div>
        {!connected && (
          <div className="mode-toggle" role="radiogroup" aria-label="Session mode">
            <button type="button" role="radio" aria-checked={mode === "voice"} className={`mode-option${mode === "voice" ? " mode-option-active" : ""}`} onClick={() => setMode("voice")}>
              Voice
            </button>
            <button type="button" role="radio" aria-checked={mode === "text"} className={`mode-option${mode === "text" ? " mode-option-active" : ""}`} onClick={() => setMode("text")} title="Same agent and tools, no audio. For rehearsal.">
              Text
            </button>
          </div>
        )}
      </div>

      {errorText && <div className="banner banner-error">{errorText}</div>}

      <div className="transcript" ref={scrollRef}>
        {transcript.length === 0 && (
          <div className="transcript-empty">
            {mode === "voice" ? "Transcript will appear here once the call connects." : "Text rehearsal: same agent, same tools, no audio."}
          </div>
        )}
        {transcript.map((turn) => (
          <div key={turn.id} className={`transcript-turn transcript-${turn.source}`}>
            <span className="transcript-source">{turn.source === "ai" ? "Agent" : "You"}</span>
            <span className="transcript-message">{turn.message}</span>
          </div>
        ))}
      </div>

      {mode === "text" && (
        <form className="text-composer" onSubmit={handleSend}>
          <input
            ref={inputRef}
            className="text-composer-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={connected ? "Type what you would say on the call…" : "Start a text session first"}
            disabled={!connected}
          />
          <button type="submit" className="text-composer-send" disabled={!connected || !draft.trim()}>
            Send
          </button>
        </form>
      )}
    </div>
  );
}

export function CallPanel(props: { incidentId: string; onConversationId: (id: string) => void }) {
  return (
    <ConversationProvider>
      <CallPanelInner {...props} />
    </ConversationProvider>
  );
}
