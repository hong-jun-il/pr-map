import { cache } from "./cache";
import { api } from "./api";

export async function loadProfile(id: string) {
  const hit = await cache.get(id);
  if (hit && !hit.stale) return hit;
  try {
    const profile = await api.fetchProfile(id);
    await cache.set(id, profile);
    return profile;
  } catch (err) {
    await cache.delete(id).catch(() => {});
    throw err;
  }
}
