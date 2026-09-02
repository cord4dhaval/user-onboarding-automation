import type { BrandAdapter, RawBrand } from "./types.js";

/**
 * A design-token endpoint: GET JSON, hand it to the token map. Covers Style Dictionary
 * output, a W3C token file, or a company's own brand API — anything that answers with a
 * document rather than speaking MCP.
 */
export class HttpBrandAdapter implements BrandAdapter {
  constructor(
    private readonly url: string,
    private readonly token?: string,
  ) {}

  async fetch(): Promise<RawBrand> {
    const res = await fetch(this.url, {
      headers: {
        accept: "application/json",
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      signal: AbortSignal.timeout(20_000),
    });
    // Error bodies from APIs routinely echo the token back; report the status only.
    if (!res.ok) throw new Error(`brand fetch failed: HTTP ${res.status}`);

    const body = (await res.json()) as unknown;
    return body && typeof body === "object" ? (body as RawBrand) : {};
  }
}
