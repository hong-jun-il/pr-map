import { cache } from "./cache";
import { api } from "./api";

export async function loadProfile(id: string) {
  const hit = await cache.get(id);
  if (hit) return hit;
  const profile = await api.fetchProfile(id);
  await cache.set(id, profile);
  return profile;
}
