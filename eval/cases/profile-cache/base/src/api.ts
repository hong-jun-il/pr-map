export const api = {
  async fetchProfile(id: string) {
    const res = await fetch(`/profiles/${id}`);
    if (!res.ok) throw new Error(`profile ${id}: ${res.status}`);
    return { name: (await res.json()).name as string, stale: false };
  },
};
