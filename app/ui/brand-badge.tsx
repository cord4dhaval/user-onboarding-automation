import { Globe, Plug, UserPlus } from "lucide-react";

/**
 * Says whether mail is going out in the tenant's own colours, and if not, what to do
 * about it. The same job `ClaudeBadge` does for queued work: the difference between
 * "broken" and "not set up yet".
 */
export interface BrandState {
  /** True once anything real has been resolved — a website read, a provider, or typed values. */
  branded: boolean;
  sources: number;
  accent?: string;
}

/**
 * The suggested provider is configuration, not code. An unset one leaves the generic
 * route — connect any MCP server that exposes a brand tool — rather than advertising a
 * product this deployment may not use.
 */
function provider() {
  const name = process.env.BRAND_PROVIDER_NAME;
  if (!name) return null;
  return {
    name,
    signupUrl: process.env.BRAND_PROVIDER_SIGNUP_URL,
    mcpUrl: process.env.BRAND_PROVIDER_MCP_URL,
  };
}

export default function BrandBadge({
  productId,
  state,
  /** Beside a heading there is room for a pill and none for a paragraph of advice. */
  compact = false,
}: {
  productId: string;
  state: BrandState;
  compact?: boolean;
}) {
  if (state.branded || compact) {
    return (
      <span
        className={`pill ${state.branded ? "ok" : "warn"}`}
        title={`${state.sources} brand source${state.sources === 1 ? "" : "s"}`}
      >
        {state.accent && <span className="dot" style={{ background: state.accent }} aria-hidden="true" />}
        {state.branded ? "Brand kit active" : "No brand kit"}
      </span>
    );
  }

  const p = provider();
  const connectHref = p?.mcpUrl
    ? `/products/${productId}/connections/new?serverUrl=${encodeURIComponent(p.mcpUrl)}`
    : `/products/${productId}/connections/new`;

  return (
    <div className="note brand-cue">
      <strong>No brand kit yet — mail is going out unstyled.</strong>
      <p>
        The fastest fix reads your own site: no account anywhere, about ten seconds.{" "}
        {p ? `A provider such as ${p.name} gives a fuller sheet` : "A brand provider gives a fuller sheet"} — logo
        variants, type scale, dark palette.
      </p>
      <div className="row">
        <a className="btn sm" href={`/products/${productId}/brand`}>
          <Globe size={14} /> Read my website
        </a>
        {p?.signupUrl && (
          <a className="btn ghost sm" href={p.signupUrl} target="_blank" rel="noreferrer noopener">
            <UserPlus size={14} /> Create a {p.name} account
          </a>
        )}
        <a className="btn ghost sm" href={connectHref}>
          <Plug size={14} /> Connect a brand MCP
        </a>
      </div>
    </div>
  );
}
