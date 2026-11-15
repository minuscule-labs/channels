import type { LocalRuntimeSessionIntegrations } from "@minu/channels-control/contracts";
import { observationLabel } from "../lib/operation-diagnostics";

export function SessionIntegrationInspection({ snapshot }: { snapshot?: LocalRuntimeSessionIntegrations }) {
  const age = snapshot ? Math.max(0, Math.floor((Date.now() - Date.parse(snapshot.capturedAt)) / 1000)) : undefined;
  return <section aria-label="Integrations" className="space-y-2">
    <h4 className="font-semibold">Integrations</h4>
    <p>{snapshot ? observationLabel(snapshot.status) : "Unavailable"}</p>
    {snapshot ? <>
      <p><time dateTime={snapshot.capturedAt}>{snapshot.capturedAt}</time> · {age}s</p>
      {snapshot.workerId ? <p>Worker: <code>{snapshot.workerId}</code></p> : null}
      <p>Configuration: {snapshot.coverage.configuration} · Tools: {snapshot.coverage.tools}</p>
      <p>Inspect: {snapshot.operations.inspect} · Reconnect: {snapshot.operations.reconnect} · Reload configuration: {snapshot.operations.reloadConfiguration}</p>
      {snapshot.integrations.length ? <div className="overflow-x-auto"><table className="w-full text-left text-sm">
        <thead><tr><th>Name</th><th>Kind</th><th>Source</th><th>Configuration</th><th>Connection</th><th>Failure</th><th>Offered</th><th>Registered</th><th>Callable</th><th>Reachable</th><th>Coverage</th></tr></thead>
        <tbody>{snapshot.integrations.map(entry => <tr key={entry.id}>
          <td>{entry.name}</td><td>{entry.kind}</td><td>{entry.source}</td><td>{entry.configured}</td><td>{observationLabel(entry.connection)}</td><td>{entry.failureCode ? observationLabel(entry.failureCode) : "—"}</td>
          <td>{entry.offeredCount ?? "Unknown"}</td><td>{entry.registeredCount ?? "Unknown"}</td><td>{entry.callableCount ?? "Unknown"}</td><td>{entry.reachableCount ?? "Unknown"}</td><td>{entry.toolCoverage}</td>
        </tr>)}</tbody>
      </table></div> : <p>{snapshot.coverage.configuration === "complete" ? "None" : "Unknown"}</p>}
      {snapshot.tools.length ? <details><summary>Registered tools ({snapshot.tools.length})</summary>
        <ul>{snapshot.tools.map(tool => <li key={tool.name}><code>{tool.name}</code> · {tool.visibility} · {tool.routes.join(", ") || "Unknown"} · {observationLabel(tool.reachability)}</li>)}</ul>
      </details> : null}
      {snapshot.issues.length ? <ul aria-label="Integration issues">{snapshot.issues.map(issue => <li key={issue}>{observationLabel(issue)}</li>)}</ul> : null}
    </> : null}
  </section>;
}
