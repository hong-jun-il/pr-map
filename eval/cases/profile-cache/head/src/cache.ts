export interface Entry {
  name: string;
  stale: boolean;
}

const store = new Map<string, Entry>();

export const cache = {
  async get(id: string) {
    return store.get(id);
  },
  async set(id: string, value: Entry) {
    store.set(id, value);
  },
  async delete(id: string) {
    store.delete(id);
  },
};
