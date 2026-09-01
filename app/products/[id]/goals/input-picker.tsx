"use client";

import { useState } from "react";

export interface ToolChoice {
  value: string;
  label: string;
  likely: boolean;
}

type InputType = "audience" | "mcp" | "api" | "file" | "none";

/**
 * Only the fields belonging to the chosen input are rendered. Showing all three at once
 * asks the reader to work out which ones apply, and leaves empty fields in the payload
 * that look like they were skipped rather than never asked for.
 */
export interface AudienceChoice {
  id: string;
  name: string;
  size: number;
  kind: string;
}

export default function InputPicker({
  productId,
  toolChoices,
  audiences = [],
}: {
  productId: string;
  toolChoices: ToolChoice[];
  audiences?: AudienceChoice[];
}) {
  const [type, setType] = useState<InputType>(audiences.length ? "audience" : "mcp");
  // An audience is re-checked on a schedule just like a pull, so it needs an interval.
  const recurring = type === "mcp" || type === "api" || type === "audience";

  return (
    <>
      <h3 style={{ fontSize: 15, margin: "20px 0 0" }}>Where leads come from</h3>
      <p className="sub" style={{ margin: "2px 0 0" }}>
        A file arrives once. An MCP tool or an API is polled on an interval you set.
      </p>

      <label>
        Input
        <select name="inputType" value={type} onChange={(e) => setType(e.target.value as InputType)}>
          <option value="audience">Audience from the library</option>
          <option value="mcp">MCP tool — recurring</option>
          <option value="api">API endpoint + token — recurring</option>
          <option value="file">Spreadsheet upload — one off</option>
          <option value="none">None for now</option>
        </select>
      </label>

      {type !== "none" && (
        <label>
          Input name
          <input name="inputName" placeholder="TeamGrid CRM leads" />
        </label>
      )}

      {type === "audience" && (
        <label>
          Which audience
          <select name="audienceId" defaultValue={audiences[0]?.id}>
            {audiences.length === 0 && <option value="">— none built yet —</option>}
            {audiences.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} — {a.size} {a.size === 1 ? "person" : "people"} ({a.kind})
              </option>
            ))}
          </select>
          {audiences.length === 0 ? (
            <span className="muted" style={{ fontSize: 13 }}>
              <a href={`/products/${productId}/audiences`}>Build one</a> from your library first.
            </span>
          ) : (
            <span className="muted" style={{ fontSize: 13 }}>
              A dynamic audience keeps feeding this campaign as people become eligible.
            </span>
          )}
        </label>
      )}

      {type === "mcp" && (
        <label>
          Which tool returns the leads
          <select name="mcpTool" defaultValue={toolChoices[0]?.value}>
            {toolChoices.length === 0 && <option value="">— no discovered tools —</option>}
            {toolChoices.map((t) => (
              <option key={t.value} value={t.value}>
                {t.likely ? `${t.label}  ★` : t.label}
              </option>
            ))}
          </select>
          {toolChoices.length === 0 && (
            <span className="muted" style={{ fontSize: 13 }}>
              <a href={`/products/${productId}/connections`}>Connect a server</a> and run Discover tools first.
            </span>
          )}
        </label>
      )}

      {type === "api" && (
        <>
          <label>
            Endpoint
            <input name="apiUrl" type="url" placeholder="https://api.example.com/v1/leads" />
          </label>
          <label>
            Bearer token
            <input name="apiToken" type="password" placeholder="token" />
          </label>
          <label>
            Cursor parameter <span className="muted">(optional — how it resumes)</span>
            <input name="cursorParam" placeholder="updated_since" />
          </label>
        </>
      )}

      {type === "file" && (
        <label>
          File <span className="muted">(.xlsx or .csv — columns are read from the header row)</span>
          <input name="file" type="file" accept=".xlsx,.xls,.csv" />
        </label>
      )}

      {recurring && (
        <div className="grid">
          <label>
            Check every
            <select name="fetchEverySec" defaultValue="600">
              <option value="300">5 minutes</option>
              <option value="600">10 minutes</option>
              <option value="1800">30 minutes</option>
              <option value="3600">1 hour</option>
              <option value="86400">1 day</option>
            </select>
          </label>
          <label>
            Urgency
            <select name="triggerMode" defaultValue="batch">
              <option value="realtime">Real time — first message goes out immediately</option>
              <option value="batch">Batch — wait for a civil hour where they are</option>
            </select>
          </label>
        </div>
      )}
    </>
  );
}
