import { getDb } from "@/db/client.js";
import { COLLECTIONS as C } from "@/db/collections.js";
import { audienceCount } from "@/engine/library.js";
import { deleteAudience, saveAudience } from "../../../actions";
import { requireSession, scope } from "../../../tenant";
import ConfirmButton from "../../../ui/confirm";
import AudienceDrawer from "./audience-drawer";

export const dynamic = "force-dynamic";

function describe(filter: Record<string, unknown> | undefined): string {
  if (!filter) return "everyone";
  const parts: string[] = [];
  if (filter.silentDays) parts.push(`not messaged for ${String(filter.silentDays)}d`);
  if (filter.quietDays) parts.push(`quiet for ${String(filter.quietDays)}d`);
  if ((filter.lifecycle as string[])?.length) parts.push((filter.lifecycle as string[]).join(" or "));
  if ((filter.temperature as string[])?.length) parts.push((filter.temperature as string[]).join(" or "));
  if (filter.everEngaged) parts.push("has engaged before");
  if (filter.minIcpFit) parts.push(`fit ≥ ${String(filter.minIcpFit)}`);
  return parts.length ? parts.join(" · ") : "everyone, minus anyone who said no";
}

export default async function Audiences({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { orgId } = await requireSession();
  const db = await getDb();

  const audiences = await db.collection(C.audiences).find(scope(orgId, id)).sort({ createdAt: -1 }).toArray();
  const sized = await Promise.all(
    audiences.map(async (a) => ({ audience: a, size: await audienceCount(orgId, id, a) })),
  );

  return (
    <>
      <div className="head">
        <div>
          <h1>Audiences</h1>
          <p className="sub" style={{ marginBottom: 0 }}>
            Groups built from the library, ready to point a campaign at. A static one is a list you picked; a
            dynamic one is a filter that keeps re-evaluating, so the campaign never runs out.
          </p>
        </div>
        <div className="spacer" />
        <AudienceDrawer productId={id} action={saveAudience} />
      </div>

      {sized.length === 0 ? (
        <div className="empty">
          <strong>No audiences yet</strong>
          Build one from the people in your <a href={`/products/${id}/library`}>library</a>, then aim a campaign at it.
        </div>
      ) : (
        <div className="tw scroll">
          <table>
            <thead><tr><th>Audience</th><th>Kind</th><th>Who is in it</th><th>People</th><th /></tr></thead>
            <tbody>
              {sized.map(({ audience, size }) => (
                <tr key={String(audience._id)}>
                  <td>
                    <strong>{String(audience.name)}</strong>
                    {audience.description ? (
                      <div className="muted" style={{ fontSize: 12.5 }}>{String(audience.description)}</div>
                    ) : null}
                  </td>
                  <td>
                    <span className={`pill ${audience.kind === "dynamic" ? "accent" : ""}`}>{String(audience.kind)}</span>
                  </td>
                  <td className="muted">{describe(audience.filter as Record<string, unknown> | undefined)}</td>
                  <td className="num">{size}</td>
                  <td>
                    <div className="row">
                      <AudienceDrawer
                        productId={id}
                        action={saveAudience}
                        label="Edit"
                        existing={{
                          id: String(audience._id),
                          name: String(audience.name),
                          description: audience.description ? String(audience.description) : undefined,
                          kind: String(audience.kind),
                          filter: audience.filter as Record<string, unknown> | undefined,
                        }}
                      />
                      <ConfirmButton
                        title={`Delete "${String(audience.name)}"?`}
                        body="The audience goes; the people in it stay in the library. Any campaign pointed at it will lose its input."
                        confirmLabel="Delete audience"
                        action={deleteAudience.bind(null, id, String(audience._id))}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
