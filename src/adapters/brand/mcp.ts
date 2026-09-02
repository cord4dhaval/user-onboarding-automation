import type { McpClient } from "../../mcp/client.js";
import { invoke, type Binding } from "../../mcp/binding.js";
import type { BrandAdapter, RawBrand } from "./types.js";

/**
 * Pulls a brand sheet through whatever tool the provider happens to expose. The tool name
 * and argument mapping live in the binding and the shape mapping lives in the source's
 * token map, so a second brand provider with entirely different names needs no code here.
 */
export class McpBrandAdapter implements BrandAdapter {
  constructor(
    private readonly client: McpClient,
    private readonly binding: Binding,
    private readonly productId: string,
  ) {}

  async fetch(): Promise<RawBrand> {
    const result = await invoke(this.client, this.binding, "fetch_brand", {
      productId: this.productId,
    });
    // `invoke` returns mapped fields when the binding declares them and `{ raw }` when it
    // does not. Token map paths are written against whichever arrives.
    return result.raw && typeof result.raw === "object" ? (result.raw as RawBrand) : result;
  }
}
