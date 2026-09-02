"use client";

import { useState } from "react";
import { Globe, Plug, Upload, Users } from "lucide-react";
import type { ReactNode } from "react";

export interface ToolChoice {
  value: string;
  label: string;
  likely: boolean;
}

export interface AudienceChoice {
  id: string;
  name: string;
  size: number;
  kind: string;
}

type InputType = "audience" | "mcp" | "api" | "file";

const SOURCES: Array<{ key: InputType; label: string; icon: ReactNode }> = [
  { key: "audience", label: "Audience", icon: <Users /> },
  { key: "mcp", label: "MCP tool", icon: <Plug /> },
  { key: "api", label: "API", icon: <Globe /> },
  { key: "file", label: "File", icon: <Upload /> },
];

/**
 * Only the fields belonging to the chosen input are rendered. Showing all four at once
 * asks the reader to work out which ones apply, and leaves empty fields in the payload
 * that look like they were skipped rather than never asked for.
 */
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
  const recurring = type !== "file";

  return (
    <>
      <div>
        <div className="label" style={{ marginBottom: 6 }}>Who comes in</div>
        <input type="hidden" name="inputType" value={type} />
        <div className="segmented">
          {SOURCES.map((src) => (
            <button
              key={src.key}
              type="button"
              className={type === src.key ? "on" : undefined}
              onClick={() => setType(src.key)}
            >
              {src.icon} {src.label}
            </button>
          ))}
        </div>
      </div>

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
          <span className="muted" style={{ fontSize: 12.5 }}>
            {audiences.length === 0 ? (
              <>
                <a href={`/products/${productId}/library?tab=audiences`}>Build one</a> from your library first.
              </>
            ) : (
              "A dynamic audience keeps feeding this campaign as people become eligible."
            )}
          </span>
        </label>
      )}

      {type === "mcp" && (
        <label>
          Which tool returns the leads
          <select name="mcpTool" defaultValue={toolChoices[0]?.value}>
            {toolChoices.length === 0 && <option value="">— no discovered tools —</option>}
            {toolChoices.map((t) => (
              <option key={t.value} value={t.value}>
                {t.likely ? `★ ${t.label}` : t.label}
              </option>
            ))}
          </select>
          {toolChoices.length === 0 && (
            <span className="muted" style={{ fontSize: 12.5 }}>
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
        </>
      )}

      {type === "file" && (
        <label>
          Spreadsheet <span className="muted">— .xlsx or .csv, columns read from the header row</span>
          <input name="file" type="file" accept=".xlsx,.xls,.csv" />
        </label>
      )}

      {recurring && (
        <label>
          Check for new people
          <select name="fetchEverySec" defaultValue="600">
            <option value="300">Every 5 minutes</option>
            <option value="600">Every 10 minutes</option>
            <option value="1800">Every 30 minutes</option>
            <option value="3600">Every hour</option>
            <option value="86400">Once a day</option>
          </select>
        </label>
      )}
    </>
  );
}
