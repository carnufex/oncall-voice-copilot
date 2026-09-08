import { useEffect, useState } from "react";
import { IndexPage } from "./components/IndexPage.js";
import { CallPage } from "./components/CallPage.js";

function useRoute(): { name: "index" } | { name: "call"; id: string } {
  const [path, setPath] = useState(window.location.pathname);

  useEffect(() => {
    const onPopState = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const match = path.match(/^\/call\/([^/]+)\/?$/);
  if (match) return { name: "call", id: match[1]! };
  return { name: "index" };
}

export function App() {
  const route = useRoute();
  if (route.name === "call") return <CallPage incidentId={route.id} />;
  return <IndexPage />;
}
