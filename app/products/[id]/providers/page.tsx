import { requireSession } from "../../../tenant";

export const dynamic = "force-dynamic";

const CAPABILITIES = [
  { key: "research", when: "Before the first message, once per company", eg: "Apify, a scraper, a search API" },
  { key: "enrich", when: "On ingest, to fill in role and company size", eg: "Any enrichment API you already pay for" },
  { key: "image", when: "When a template asks for one and the budget allows", eg: "OpenAI, Gemini, Replicate" },
  { key: "render", when: "Whenever a message shows someone their own numbers", eg: "Built in — near-free, and correct" },
  { key: "video", when: "High-value segments only, gated on expected value", eg: "Whichever you connect" },
  { key: "voice", when: "Narration for a generated video", eg: "Whichever you connect" },
];

export default async function Providers({ params }: { params: Promise<{ id: string }> }) {
  await params;
  await requireSession();

  return (
    <>
      <h1>Providers</h1>
      <p className="sub">
        Outside services the engine may call while it works — to research a company before writing to it, to
        make an image a message needs, to render someone&apos;s own numbers as a chart. One key each, with a
        budget the engine enforces before every call.
      </p>

      <div className="empty">
        <strong>No providers connected</strong>
        Everything runs without them. Adding one widens what Claude may plan; it never changes what already went out.
      </div>

      <h2>What a provider can be</h2>
      <div className="tw scroll">
        <table>
          <thead><tr><th>Capability</th><th>Runs when</th><th>Typically</th></tr></thead>
          <tbody>
            {CAPABILITIES.map((c) => (
              <tr key={c.key}>
                <td><code>{c.key}</code></td>
                <td>{c.when}</td>
                <td className="muted">{c.eg}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="note">
        <p><strong>Missing is not broken.</strong> With no image provider, a template asking for one falls back
        to text rather than failing the send. The budget is a hard ceiling checked in code — a provider at its
        limit is simply unavailable, and the pipeline routes around it exactly as it routes around a degraded
        channel.</p>
      </div>
    </>
  );
}
