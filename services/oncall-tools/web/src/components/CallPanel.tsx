import { ConversationProvider, useConversation } from "@elevenlabs/react";
import { useEffect, useRef, useState } from "react";
import { startSessionForIncident, reportConversationId } from "../api.js";

type TranscriptTurn = { id: number; source: "ai" | "user"; message: string };

function CallPanelInner({ incidentId, onConversationId }: { incidentId: string; onConversationId: (id: string) => void }) {
  const [transcript, setTranscript] = useState<TranscriptTurn[]>([]);
  const [errorText, setErrorText] = useState<string | undefined>(undefined);
  const [starting, setStarting] = useState(false);
  const nextId = useRef(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);

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

  async function handleAnswer() {
    setErrorText(undefined);
    setStarting(true);
    try {
      const session = await startSessionForIncident(incidentId);
      await conversation.startSession({
        conversationToken: session.conversation_token,
        connectionType: "webrtc",
        dynamicVariables: session.dynamic_variables,
      });
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : "Failed to start the call");
    } finally {
      setStarting(false);
    }
  }

  async function handleHangUp() {
    await conversation.endSession();
  }

  const connected = conversation.status === "connected";
  const statusLabel = connected ? conversation.mode : conversation.status;

  return (
    <div className="call-panel">
      <div className="call-panel-controls">
        {!connected ? (
          <button className="answer-button" onClick={handleAnswer} disabled={starting || conversation.status === "connecting"}>
            {starting || conversation.status === "connecting" ? "Connecting…" : "Answer call"}
          </button>
        ) : (
          <button className="hangup-button" onClick={handleHangUp}>
            Hang up
          </button>
        )}
        <div className={`call-status call-status-${statusLabel}`}>
          <span className="call-status-dot" />
          {statusLabel}
        </div>
      </div>

      {errorText && <div className="banner banner-error">{errorText}</div>}

      <div className="transcript" ref={scrollRef}>
        {transcript.length === 0 && (
          <div className="transcript-empty">Transcript will appear here once the call connects.</div>
        )}
        {transcript.map((turn) => (
          <div key={turn.id} className={`transcript-turn transcript-${turn.source}`}>
            <span className="transcript-source">{turn.source === "ai" ? "Agent" : "You"}</span>
            <span className="transcript-message">{turn.message}</span>
          </div>
        ))}
      </div>
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
