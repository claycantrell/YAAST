// Open this file in the Extension Development Host to see Semantic Fold Mode
// rendering virtual headers above each symbol.

export class UserService {
  private cache = new Map<string, User>();

  async findById(id: string): Promise<User | undefined> {
    if (this.cache.has(id)) return this.cache.get(id);
    const user = await fetchUser(id);
    if (user) this.cache.set(id, user);
    return user;
  }

  invalidate(id: string): void {
    this.cache.delete(id);
  }
}

export interface User {
  id: string;
  name: string;
  email: string;
}

export async function fetchUser(id: string): Promise<User | undefined> {
  const res = await fetch(`/api/users/${id}`);
  if (!res.ok) return undefined;
  return (await res.json()) as User;
}

export function buildIndex(items: User[]): Map<string, User> {
  const index = new Map<string, User>();
  for (const item of items) {
    if (item.id) index.set(item.id, item);
  }
  return index;
}

export function tokenize(text: string): string[] {
  return text.toLowerCase().split(/\s+/).filter(Boolean);
}
