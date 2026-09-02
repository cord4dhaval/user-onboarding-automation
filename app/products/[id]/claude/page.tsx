import { Activity, Clock, Plug } from "lucide-react";
import { requireSession } from "../../../tenant";
import { Tabs } from "../../../ui/kit";
import SetupPanel from "./setup-panel";
import RoutinesPanel from "./routines-panel";
import LogsPanel from "./logs-panel";

export const dynamic = "force-dynamic";

type Tab = "setup" | "routines" | "logs";

/**
 * Connecting Claude, scheduling its routines and reading what those runs did are three
 * views of one thing. They were three sidebar entries, which made a single setup task
 * look like three unrelated ones.
 */
export default async function Claude({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string; routine?: string }>;
}) {
  const { id } = await params;
  const { tab, routine } = await searchParams;
  const current: Tab = tab === "routines" || tab === "logs" ? tab : "setup";
  const { orgId } = await requireSession();
  const base = `/products/${id}/claude`;

  return (
    <>
      <div className="head">
        <div>
          <h1>Claude</h1>
          <p className="sub" style={{ marginBottom: 0 }}>
            The engine sends on its own clock. Claude does the thinking — who this person is, what pipeline
            they should get, and what each message actually says.
          </p>
        </div>
      </div>

      <Tabs
        current={current}
        tabs={[
          { key: "setup", label: "Connection", href: base, icon: <Plug /> },
          { key: "routines", label: "Routines", href: `${base}?tab=routines`, icon: <Clock /> },
          { key: "logs", label: "Runs", href: `${base}?tab=logs`, icon: <Activity /> },
        ]}
      />

      {current === "setup" && <SetupPanel productId={id} orgId={orgId} />}
      {current === "routines" && <RoutinesPanel productId={id} orgId={orgId} />}
      {current === "logs" && <LogsPanel productId={id} orgId={orgId} routine={routine} />}
    </>
  );
}
