"use client";

import { useState } from "react";
import { Globe, Palette, Plus, Server } from "lucide-react";
import Drawer from "../../../ui/drawer";
import { Button, SubmitButton } from "../../../ui/kit";

export interface ConnectionChoice {
  id: string;
  provider: string;
}

/** The three ways to add a source, behind one button rather than three stacked cards. */
export function AddSourceDrawer({
  productId,
  action,
  connections,
}: {
  productId: string;
  action: (formData: FormData) => void | Promise<void>;
  connections: ConnectionChoice[];
}) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState("css_vars");

  return (
    <>
      <Button icon={<Plus />} onClick={() => setOpen(true)}>
        Add source
      </Button>

      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title="Add a brand source"
        description="Several can run at once. They merge lowest precedence first, so a later one only fills what the others left."
      >
        <form action={action} className="stack">
          <input type="hidden" name="productId" value={productId} />

          <fieldset className="choices">
            <legend>Where the values come from</legend>
            {[
              { value: "css_vars", icon: <Globe size={15} />, label: "A website", hint: "Reads colours, fonts and the site mark off a public page. No account needed." },
              { value: "http_tokens", icon: <Palette size={15} />, label: "Token endpoint", hint: "Any URL returning JSON — Style Dictionary, a W3C token file, your own API." },
              { value: "mcp_brand", icon: <Server size={15} />, label: "Brand MCP", hint: "A connected server exposing a brand tool, bound to fetch_brand." },
            ].map((option) => (
              <label key={option.value} className={`choice ${kind === option.value ? "on" : ""}`}>
                <input
                  type="radio"
                  name="kind"
                  value={option.value}
                  checked={kind === option.value}
                  onChange={() => setKind(option.value)}
                />
                <span className="choice-icon">{option.icon}</span>
                <span>
                  <strong>{option.label}</strong>
                  <span className="hint">{option.hint}</span>
                </span>
              </label>
            ))}
          </fieldset>

          <label>
            Name
            <input name="name" placeholder={kind === "css_vars" ? "Website" : "Design tokens"} required />
          </label>

          {kind === "mcp_brand" ? (
            <label>
              Connection
              {connections.length ? (
                <select name="connectionId" required>
                  {connections.map((connection) => (
                    <option key={connection.id} value={connection.id}>
                      {connection.provider}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="hint">
                  No connections yet. <a href={`/products/${productId}/connections/new`}>Add an MCP server</a> first.
                </span>
              )}
            </label>
          ) : (
            <label>
              URL
              <input
                name="url"
                type="url"
                placeholder={kind === "css_vars" ? "https://example.com" : "https://example.com/tokens.json"}
                required
              />
            </label>
          )}

          <div className="drawer-foot">
            <SubmitButton pendingLabel="Reading">Add and read</SubmitButton>
            <Button variant="quiet" type="button" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      </Drawer>
    </>
  );
}

/** Hand-typed values, which sit above everything fetched. */
export function OverridesDrawer({
  productId,
  action,
  current,
}: {
  productId: string;
  action: (formData: FormData) => void | Promise<void>;
  current: {
    color?: Record<string, string>;
    logo?: Record<string, string>;
    font?: Record<string, string>;
    footer?: Record<string, string>;
  };
}) {
  const [open, setOpen] = useState(false);
  const colour = (key: string) => current.color?.[key] ?? "";

  return (
    <>
      <Button variant="quiet" icon={<Palette />} onClick={() => setOpen(true)}>
        Overrides
      </Button>

      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title="Overrides"
        description="Typed values sit above everything fetched, so a refresh can never overwrite a decision you made on purpose."
        width={560}
      >
        <form action={action} className="stack">
          <input type="hidden" name="productId" value={productId} />

          <fieldset className="fieldset">
            <legend>Colour</legend>
            <div className="cols">
              {[
                ["accent", "Accent", "#2c5cff"],
                ["accentText", "Accent text", "#ffffff"],
                ["bg", "Page background", "#f4f5f7"],
                ["surface", "Card surface", "#ffffff"],
                ["text", "Body text", "#101114"],
                ["muted", "Muted text", "#6b7280"],
              ].map(([key, label, placeholder]) => (
                <label key={key}>
                  {label}
                  <input name={key} placeholder={placeholder} defaultValue={colour(key!)} />
                </label>
              ))}
            </div>
            <label>
              Button gradient <span className="muted">— two or three hex stops, comma separated</span>
              <input
                name="gradient"
                placeholder="#2c5cff, #7b3fe4, #e5342b"
                defaultValue={(current.color?.gradient as unknown as string[] | undefined)?.join(", ") ?? ""}
              />
              <span className="hint">Empty means a flat accent button.</span>
            </label>
          </fieldset>

          <fieldset className="fieldset">
            <legend>Logo</legend>
            <label>
              Image URL <span className="muted">— must be publicly hosted</span>
              <input name="logoUrl" type="url" defaultValue={current.logo?.light ?? ""} />
              <span className="hint">
                Mail clients strip attachments and data URLs alike. With no logo the legal name is set as a
                wordmark instead.
              </span>
            </label>
            <label>
              Width
              <input name="logoWidth" type="number" min={40} max={320} defaultValue={current.logo?.width ?? ""} />
            </label>
          </fieldset>

          <fieldset className="fieldset">
            <legend>Type</legend>
            <label>
              Heading stack
              <input
                name="headingStack"
                placeholder="'Inter', Helvetica, Arial, sans-serif"
                defaultValue={current.font?.headingStack ?? ""}
              />
            </label>
            <label>
              Body stack
              <input
                name="bodyStack"
                placeholder="Helvetica, Arial, sans-serif"
                defaultValue={current.font?.bodyStack ?? ""}
              />
              <span className="hint">A generic family is appended automatically — mail has no webfonts.</span>
            </label>
          </fieldset>

          <fieldset className="fieldset">
            <legend>Footer</legend>
            <label>
              Legal name
              <input name="legalName" defaultValue={current.footer?.legalName ?? ""} />
              <span className="hint">Required in the footer by CAN-SPAM and GDPR alike.</span>
            </label>
            <label>
              Postal address
              <input name="address" defaultValue={current.footer?.address ?? ""} />
            </label>
          </fieldset>

          <div className="drawer-foot">
            <SubmitButton pendingLabel="Saving">Save overrides</SubmitButton>
            <Button variant="quiet" type="button" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      </Drawer>
    </>
  );
}
