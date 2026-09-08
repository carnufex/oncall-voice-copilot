import { useEffect, useRef, useState } from "react";
import { fetchIncident } from "../api.js";
import type { CommitDiff, Incident } from "../types.js";
import { StatusPill } from "./StatusPill.js";
import { CallPanel } from "./CallPanel.js";
import { Timeline } from "./Timeline.js";
import { DiffCard } from "./DiffCard.js";
import { CopyChip } from "./CopyChip.js";
import { ChevronLeftIcon } from "./Icons.js";
import { minutesAgo, formatClock } from "../utils.js";

const POLL_MS = 2000;

export function CallPage({ incidentId }: { incidentId: string }) {
  const [incident, setIncident] = useState<Incident | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [conversationId, setConversationId] = useState<string | undefined>(undefined);
  const [diff, setDiff] = useState<CommitDiff | undefined>(undefined);
  const pollRef = useRef<number | undefined>(undefined);

  // Dev-only escape hatch so the diff card can be exercised visually without a live agent
  // call — `import.meta.env.DEV` is statically false in production builds, so Vite dead-code
  // eliminates this whole effect (and the window hook) from the shipped bundle.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const w = window as unknown as { __showDiff?: (d: CommitDiff | undefined) => void };
    w.__showDiff = setDiff;
    return () => {
      delete w.__showDiff;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const data = await fetchIncident(incidentId);
        if (!cancelled) {
          setIncident(data);
          setError(undefined);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load incident");
      }
    }
    void poll();
    pollRef.current = window.setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, [incidentId]);

  if (error && !incident) {
    return (
      <div className="call-page call-page-error">
        <div className="banner banner-error">{error === "incident_not_found" ? `No incident found for ${incidentId}.` : error}</div>
        <a className="back-link" href="/">
          <ChevronLeftIcon /> Back to incidents
        </a>
      </div>
    );
  }

  if (!incident) {
    return (
      <div className="call-page call-page-loading">
        <div className="orb-loading" aria-hidden="true" />
        <div className="loading-text">Loading incident {incidentId}…</div>
      </div>
    );
  }

  const convId = conversationId ?? incident.conversation_id;

  return (
    <div className="call-page">
      <header className="call-header">
        <a className="back-link" href="/" aria-label="Back to incidents">
          <ChevronLeftIcon />
        </a>
        <div className="call-header-main">
          <div className="call-header-title">
            <span className="call-header-service">{incident.service}</span>
            <span className="call-header-ns mono">{incident.namespace}</span>
          </div>
          <div className="call-header-chips">
            <CopyChip value={incident.id} title="Incident id" />
            {convId && <CopyChip value={convId} href={`https://elevenlabs.io/app/agents/history/${convId}`} title="Conversation id" variant="accent" />}
          </div>
        </div>
        <div className="call-header-meta">
          <StatusPill status={incident.status} />
          <span className="call-header-age">
            Opened {formatClock(incident.opened_at)} &middot; {minutesAgo(incident.opened_at)} min ago
          </span>
        </div>
      </header>

      <main className="call-body">
        <section className="call-column call-column-left">
          <CallPanel incidentId={incident.id} onConversationId={setConversationId} onShowDiff={setDiff} />
        </section>
        <section className="call-column call-column-right">
          {diff && <DiffCard diff={diff} onDismiss={() => setDiff(undefined)} />}
          <Timeline incident={incident} />
        </section>
      </main>

      <footer className="call-footer">
        <span>ElevenLabs Agents &bull; webhook tools &bull; GitOps rollback &bull; Slack</span>
        {convId && <CopyChip value={convId} href={`https://elevenlabs.io/app/agents/history/${convId}`} variant="accent" />}
      </footer>
    </div>
  );
}
