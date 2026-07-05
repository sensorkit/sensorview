import { skUrl } from "../../stores/backends";
import type { ProductInfo, ProductMetadata } from "./types";

/**
 * Client for the SensorKit data-product endpoints (FITS files collected by a
 * controller). See the SK webapi: /controller/{id}/product/{product}/{data,preview,metadata}.
 *
 * Live arrivals come over the firehose as `kind:"product"` records (handled in
 * the sensorkit store); these helpers cover the REST surface — backlog listing,
 * per-file metadata, and the URLs we hand to JS9 / <img>.
 */

function productPath(controllerId: string, productId: string, leaf: string): string {
  return skUrl(
    `/controller/${encodeURIComponent(controllerId)}/product/${encodeURIComponent(productId)}/${leaf}`,
  );
}

/** URL of the raw FITS bytes (application/fits). Hand straight to JS9.Load. */
export function productDataUrl(controllerId: string, productId: string): string {
  return productPath(controllerId, productId, "data");
}

/** URL of the server-rendered JPEG preview (image/jpeg). Use as an <img> src. */
export function productPreviewUrl(controllerId: string, productId: string): string {
  return productPath(controllerId, productId, "preview");
}

export async function fetchProductMetadata(
  controllerId: string,
  productId: string,
): Promise<ProductMetadata> {
  const url = productPath(controllerId, productId, "metadata");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} ${res.status}`);
  return res.json();
}

/**
 * Thrown when SK answers the listing with 503 — its initial directory scan
 * hasn't finished yet. Transient: the caller should retry shortly.
 */
export class ProductListingNotReady extends Error {}

/** One-shot backlog listing for a controller (filename, register time, size). */
export async function fetchControllerProducts(controllerId: string): Promise<ProductInfo[]> {
  const url = skUrl(`/controller/${encodeURIComponent(controllerId)}/products`);
  const res = await fetch(url);
  if (res.status === 503) throw new ProductListingNotReady(url);
  if (!res.ok) throw new Error(`${url} ${res.status}`);
  return res.json();
}
