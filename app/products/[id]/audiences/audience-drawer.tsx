"use client";

import { useState } from "react";
import Drawer from "../../../ui/drawer";

const STATES = ["new", "active", "cooling", "dormant"] as const;
const TEMPS = ["hot", "warm", "cold", "dead"] as const;

export default function AudienceDrawer({
  productId,
  action,
  label = "New audience",
  existing,
}: {
  productId: string;
  action: (formData: FormData) => void | Promise<void>;
  label?: string;
  existing?: {
    id: string;
    name: string;
    description?: string;
    kind: string;
    filter?: Record<string, unknown>;
  };
}) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState(existing?.kind ?? "dynamic");
  const f = (existing?.filter ?? {}) as Record<string, unknown>;

  return (
    <>
      <button type="button" className={existing ? "quiet sm" : ""} onClick={() => setOpen(true)}>
        {label}
      </button>

      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title={existing ? `Edit ${existing.name}` : "New audience"}
        description="A group of people from the library, ready to point a campaign at."
      >
        <form action={action} className="stack">
          <input type="hidden" name="productId" value={productId} />
          {existing && <input type="hidden" name="audienceId" value={existing.id} />}

          <label>Name<input name="name" defaultValue={existing?.name} placeholder="Dormant agency owners" required /></label>
          <label>
            What it is for <span className="muted">(optional)</span>
            <input name="description" defaultValue={existing?.description} placeholder="Signed up last year, never came back" />
          </label>

          <label>
            Kind
            <select name="kind" value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="dynamic">Dynamic — membership updates itself</option>
              <option value="static">Static — a fixed list you pick</option>
            </select>
          </label>

          {kind === "dynamic" ? (
            <>
              <p className="sub" style={{ margin: 0 }}>
                A campaign pointed at a dynamic audience never runs out — someone becomes eligible on a Tuesday
                and gets picked up on the next check, without anyone scheduling it.
              </p>

              <div className="grid">
                <label>
                  Not messaged for <span className="muted">days</span>
                  <input name="silentDays" type="number" min={0} defaultValue={f.silentDays as number | undefined} placeholder="90" />
                </label>
                <label>
                  No activity for <span className="muted">days</span>
                  <input name="quietDays" type="number" min={0} defaultValue={f.quietDays as number | undefined} placeholder="30" />
                </label>
              </div>

              <fieldset className="fieldset">
                <legend>State</legend>
                {STATES.map((st) => (
                  <label key={st} className="check">
                    <input
                      type="checkbox"
                      name="lifecycle"
                      value={st}
                      defaultChecked={(f.lifecycle as string[] | undefined)?.includes(st)}
                    />
                    {st}
                  </label>
                ))}
              </fieldset>

              <fieldset className="fieldset">
                <legend>Temperature</legend>
                {TEMPS.map((t) => (
                  <label key={t} className="check">
                    <input
                      type="checkbox"
                      name="temperature"
                      value={t}
                      defaultChecked={(f.temperature as string[] | undefined)?.includes(t)}
                    />
                    {t}
                  </label>
                ))}
              </fieldset>

              <label className="check">
                <input type="checkbox" name="everEngaged" defaultChecked={f.everEngaged === true} />
                Only people who have ever engaged
              </label>

              <label>
                Minimum fit <span className="muted">(0 to 1)</span>
                <input name="minIcpFit" type="number" step="0.1" min={0} max={1} defaultValue={f.minIcpFit as number | undefined} />
              </label>

              <p className="sub" style={{ margin: 0 }}>
                Anyone who has said no is always excluded, whatever the filter says.
              </p>
            </>
          ) : (
            <p className="sub" style={{ margin: 0 }}>
              Save this, then add people to it from the library by selecting rows.
            </p>
          )}

          <button type="submit">{existing ? "Save audience" : "Create audience"}</button>
        </form>
      </Drawer>
    </>
  );
}
