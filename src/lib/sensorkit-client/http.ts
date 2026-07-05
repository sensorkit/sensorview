import type { EntityListing, SKRecord } from "./types";
import { skUrl } from "../../stores/backends";

export async function fetchEntities(): Promise<EntityListing[]> {
  const url = skUrl("/entities");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`/entities ${res.status}`);
  return res.json();
}

export async function fetchSnapshot(entityId?: string): Promise<SKRecord[]> {
  const url = entityId
    ? skUrl(`/data/snapshot/${encodeURIComponent(entityId)}`)
    : skUrl("/data/snapshot");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} ${res.status}`);
  return res.json();
}
