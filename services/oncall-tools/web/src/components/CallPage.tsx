import { useEffect, useRef, useState } from "react";
import { fetchIncident } from "../api.js";
import type { Incident } from "../types.js";
import { StatusPill } from "./StatusPill.js";
import { CallPanel } from "./CallPanel.js";
import { Timeline } from "./Timeline.js";

const POLL_MS = 2000;

function minutesAgo(iso: string): number {
  return Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
}

export function CallPage({ incidentId }: { incidentId: string }) {
  const [incident, setIncident] = useState<Incident | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [conversationId, setConversationId] = useState<string | undefined>(undefined);
  const pollRef = useRef<number | undefined>(undefined);

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
          &larr; Back to incidents
        </a>
      </div>
    );
  }

  if (!incident) {
    return (
      <div className="call-page call-page-loading">
        <div className="loading-text">Loading incident {incidentId}…</div>
      </div>
    );
  }

  return (
    <div className="call-page">
      <header className="call-header">
        <a className="back-link" href="/">
          &larr;
        </a>
        <div className="call-header-main">
          <div className="call-header-title">
            <span className="call-header-service">{incident.service}</span>
            <span className="call-header-ns mono">{incident.namespace}</span>
          </div>
          <div className="call-header-sub mono">{incident.id}</div>
        </div>
        <div className="call-header-meta">
          <StatusPill status={incident.status} />
          <span className="call-header-age">Opened {minutesAgo(incident.opened_at)} min ago</span>
        </div>
      </header>

      <main className="call-body">
        <section className="call-column call-column-left">
          <CallPanel incidentId={incident.id} onConversationId={setConversationId} />
        </section>
        <section className="call-column call-column-right">
          <Timeline incident={incident} />
        </section>
      </main>

      <footer className="call-footer">
        <span>ElevenLabs Agents &bull; webhook tools &bull; GitOps rollback &bull; Slack</span>
        {(conversationId ?? incident.conversation_id) && (
          <span className="mono call-footer-conv">conversation {conversationId ?? incident.conversation_id}</span>
        )}
      </footer>
    </div>
  );
}
