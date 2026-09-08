"use client";

import { useState } from "react";
import { Globe, Plug, Upload, Users } from "lucide-react";
import type { ReactNode } from "react";
import Select from "../../../ui/select";

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
          <Select
            name="audienceId"
            value={audiences[0]?.id ?? ""}
            searchable={audiences.length > 8}
            ariaLabel="Audience this campaign draws from"
            placeholder="— none built yet —"
            options={audiences.map((a) => ({
              value: a.id,
              label: a.name,
              hint: `${a.size} ${a.size === 1 ? "person" : "people"} · ${a.kind}`,
            }))}
          />
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
          <Select
            name="mcpTool"
            value={toolChoices[0]?.value ?? ""}
            searchable={toolChoices.length > 8}
            ariaLabel="Tool that fetches new people"
            placeholder="— no discovered tools —"
            options={toolChoices.map((t) => ({
              value: t.value,
              label: t.label,
              hint: t.likely ? "likely the one you want" : undefined,
            }))}
          />
          {toolChoices.length === 0 && (
            <span className="muted" style={{ fontSize: 12.5 }}>
              <a href={`/products/${productId}/connections`}>Connect a server</a> and run Discover tools first.
            </span>
          )}
        </label>
      )}

      {/* Most lead tools need something fixed alongside the cursor — which brand, which
          list, which pipeline. Without somewhere to put it the call is rejected for a
          missing argument, and the source polls forever returning nothing. */}
      {type === "mcp" && (
        <label>
          Fixed arguments <span className="muted">(optional JSON, sent on every call)</span>
          <input name="mcpArgs" placeholder='{"brandId": "fe4479cc-ee44-4f4f-865f-8e4ca211f963"}' />
          <span className="muted" style={{ fontSize: 12.5 }}>
            The cursor is always sent. Add anything else the tool marks as required.
          </span>
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

      {/* Every input except an audience arrives in someone else's shape. Without this the
          map silently defaulted to {email, name}, which finds nothing in a provider that
          nests its answers — and a source that maps nothing looks exactly like a source
          with no new leads. */}
      {type !== "audience" && (
        <label>
          Field map <span className="muted">— where to find each field in their rows</span>
          <textarea
            name="fieldMap"
            rows={4}
            defaultValue={'{"email": "email", "name": "name"}'}
            spellCheck={false}
          />
          <span className="muted" style={{ fontSize: 12.5 }}>
            Dots go into nested objects, and a list is tried in order — useful when several
            lead forms feed one campaign under different names.
          </span>
        </label>
      )}

      {recurring && (
        <label>
          Check for new people
          <Select
            name="fetchEverySec"
            value="600"
            ariaLabel="How often to fetch"
            options={[
              { value: "300", label: "Every 5 minutes" },
              { value: "600", label: "Every 10 minutes" },
              { value: "1800", label: "Every 30 minutes" },
              { value: "3600", label: "Every hour" },
              { value: "86400", label: "Once a day" },
            ]}
          />
        </label>
      )}
    </>
  );
}
