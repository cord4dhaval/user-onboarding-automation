import { Images, Palette } from "lucide-react";
import { Tabs } from "../../../ui/kit";
import AppearancePanel from "./appearance-panel";
import AssetsPanel from "./assets-panel";

export const dynamic = "force-dynamic";

type Tab = "appearance" | "assets";

/**
 * How a message looks and what it is allowed to show are one subject. Both are read at
 * send time, both restyle or re-arm every template at once, and neither is copy. Two
 * sidebar entries made a single setup task read as two unrelated ones.
 */
export default async function Brand({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { id } = await params;
  const { tab } = await searchParams;
  const current: Tab = tab === "assets" ? "assets" : "appearance";
  const base = `/products/${id}/brand`;

  return (
    <main>
      <div className="head">
        <div>
          <h1>Brand</h1>
          <p className="sub" style={{ marginBottom: 0 }}>
            Everything a message is dressed in — the colours, logo and type it is assembled from, and the
            things it may point at. Nothing here is copy, and nothing here is fetched while a message sends.
          </p>
        </div>
      </div>

      <Tabs
        current={current}
        tabs={[
          { key: "appearance", label: "Appearance", href: base, icon: <Palette /> },
          { key: "assets", label: "Assets", href: `${base}?tab=assets`, icon: <Images /> },
        ]}
      />

      {current === "appearance" ? <AppearancePanel id={id} /> : <AssetsPanel id={id} />}
    </main>
  );
}
