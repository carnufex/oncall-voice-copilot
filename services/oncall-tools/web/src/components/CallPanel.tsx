import { ConversationProvider, useConversation } from "@elevenlabs/react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { startSessionForIncident, reportConversationId, fetchCommitDiff } from "../api.js";
import type { CommitDiff } from "../types.js";
import { VoiceOrb, type OrbState } from "./VoiceOrb.js";

type TranscriptTurn = { id: number; source: "ai" | "user"; message: string };
type SessionMode = "voice" | "text";

// Tool-running is inferred conservatively: the agent SDK only exposes "speaking"/"listening",
// so a sustained silence (no output audio) while the SDK still reports "speaking" is read as
// a tool call in flight (model composing / waiting on a tool result before TTS starts). If the
// signal is ambiguous we always fall back to the plain speaking/listening label — see SPEC.
const TOOL_SILENCE_MS = 800;
const AUDIO_ACTIVE_THRESHOLD = 0.02;
const DERIVE_INTERVAL_MS = 150;

type CallPanelProps = {
  incidentId: string;
  onConversationId: (id: string) => void;
  onShowDiff: (diff: CommitDiff | undefined) => void;
};

function CallPanelInner({ incidentId, onConversationId, onShowDiff }: CallPanelProps) {
  const [transcript, setTranscript] = useState<TranscriptTurn[]>([]);
  const [errorText, setErrorText] = useState<string | undefined>(undefined);
  const [starting, setStarting] = useState(false);
  const [mode, setMode] = useState<SessionMode>("voice");
  const [draft, setDraft] = useState("");
  const [orbState, setOrbState] = useState<OrbState>("idle");
  const [statusLabel, setStatusLabel] = useState("Ready");
  const nextId = useRef(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const hasConnectedRef = useRef(false);
  const modeStartRef = useRef(Date.now());
  const lastAudioRef = useRef(0);
  const prevSdkModeRef = useRef<string | undefined>(undefined);

  // Client tools the agent can invoke mid-call to drive the page. Returns must be
  // string | number | void (the SDK's ClientToolsConfig contract) — plain spoken-style
  // confirmations, since the actual payload goes to the UI via onShowDiff, not the return value.
  const clientTools = useMemo(
    () => ({
      show_diff: async ({ commit_sha }: { commit_sha: string }) => {
        try {
          const diff = await fetchCommitDiff(incidentId, commit_sha);
          onShowDiff(diff);
          return "diff shown";
        } catch (err) {
          return err instanceof Error ? `could not load diff: ${err.message}` : "could not load diff";
        }
      },
      clear_screen: async () => {
        onShowDiff(undefined);
        return "cleared";
      },
    }),
    [incidentId, onShowDiff],
  );

  const conversation = useConversation({
    onConnect: ({ conversationId }) => {
      hasConnectedRef.current = true;
      void reportConversationId(incidentId, conversationId);
      onConversationId(conversationId);
    },
    onMessage: ({ message, source }) => {
      setTranscript((t) => [...t, { id: nextId.current++, source, message }]);
    },
    onError: (message) => setErrorText(message),
    clientTools,
  });

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [transcript]);

  const connected = conversation.status === "connected";

  useEffect(() => {
    if (connected && mode === "text") inputRef.current?.focus();
  }, [connected, mode]);

  // Derived orb state + status label. Voice mode ticks a lightweight interval so the
  // tool-running heuristic (sustained silence during "speaking") can settle; text mode has
  // no audio so it maps directly off the SDK's speaking/listening mode.
  useEffect(() => {
    if (conversation.status === "connecting") {
      setOrbState("connecting");
      setStatusLabel("Ringing…");
      return;
    }
    if (!connected) {
      if (hasConnectedRef.current) {
        setOrbState("ended");
        setStatusLabel("Call ended");
      } else {
        setOrbState("idle");
        setStatusLabel("Ready");
      }
      return;
    }
    if (mode === "text") {
      setOrbState(conversation.mode === "speaking" ? "speaking" : "listening");
      setStatusLabel("Connected (text)");
      return;
    }

    const id = window.setInterval(() => {
      const sdkMode = conversation.mode;
      if (sdkMode !== prevSdkModeRef.current) {
        modeStartRef.current = Date.now();
        prevSdkModeRef.current = sdkMode;
      }
      const now = Date.now();
      let volume = 0;
      try {
        volume = conversation.getOutputVolume();
      } catch {
        volume = 0;
      }
      if (volume > AUDIO_ACTIVE_THRESHOLD) lastAudioRef.current = now;

      if (sdkMode === "listening") {
        setOrbState("listening");
        setStatusLabel("Listening");
        return;
      }
      const silentFor = now - lastAudioRef.current;
      const modeAge = now - modeStartRef.current;
      if (silentFor > TOOL_SILENCE_MS && modeAge > TOOL_SILENCE_MS) {
        setOrbState("tool");
        setStatusLabel("Working…");
      } else {
        setOrbState("speaking");
        setStatusLabel("Speaking");
      }
    }, DERIVE_INTERVAL_MS);
    return () => window.clearInterval(id);
    // conversation is a stable-ish object from the SDK; status/mode drive re-derivation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, conversation.status, mode, conversation.mode]);

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

  const busy = starting || conversation.status === "connecting";

  return (
    <div className="call-panel">
      <div className="call-panel-top">
        <div className="call-panel-orb">
          <VoiceOrb state={orbState} getOutputVolume={mode === "voice" ? conversation.getOutputVolume : undefined} size={260} />
          <div className={`call-status-label call-status-label-${orbState}`}>{statusLabel}</div>
        </div>

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
      </div>

      <div className="transcript" ref={scrollRef}>
        {transcript.length === 0 && (
          <div className="transcript-empty">
            <div className="transcript-empty-title">{mode === "voice" ? "No transcript yet" : "Text rehearsal"}</div>
            <div className="transcript-empty-body">
              {mode === "voice" ? "Transcript will appear here once the call connects." : "Same agent, same tools, no audio."}
            </div>
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

export function CallPanel(props: CallPanelProps) {
  return (
    <ConversationProvider>
      <CallPanelInner {...props} />
    </ConversationProvider>
  );
}
