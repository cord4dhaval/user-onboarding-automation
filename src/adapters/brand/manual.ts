import type { BrandAdapter, RawBrand } from "./types.js";

/**
 * Values typed into the form. No server, no credential, no network — and therefore the
 * one source that cannot fail, which is why it sits highest in the precedence order.
 */
export class ManualBrandAdapter implements BrandAdapter {
  constructor(private readonly literal: RawBrand) {}

  async fetch(): Promise<RawBrand> {
    return { guess: this.literal };
  }
}
