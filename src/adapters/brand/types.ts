/** Whatever the provider returned, before the token map is applied. */
export type RawBrand = Record<string, unknown>;

/**
 * Every brand input reduces to this. A brand MCP, a design-token endpoint, a stylesheet
 * and a form all differ only in how the values arrive; everything downstream is identical.
 *
 * Mirrors `SourceAdapter` deliberately — brand is a third direction on the same
 * connection/adapter/map machinery, not a special case.
 */
export interface BrandAdapter {
  fetch(): Promise<RawBrand>;
}
