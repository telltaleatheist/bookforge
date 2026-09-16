import type { EngineRole } from '../../shared/queue/slot-sets';
import { crucibleEngineUrlOf, crucibleRoleOf } from './routes';

export interface RankedEngineAddress { readonly name: string; readonly enabled: boolean }

/** One lane per verified engine, even when both its host and engine are registered. */
export function engineLanes(
  ranked: readonly RankedEngineAddress[],
  facts: (name: string) => { role: EngineRole; url: string | null } =
    (name) => ({ role: crucibleRoleOf(name), url: crucibleEngineUrlOf(name) }),
  occupied: readonly string[] = [],
): {
  ranked: RankedEngineAddress[];
  roles: Record<string, EngineRole>;
  owner: ReadonlyMap<string, string>;
} {
  const rows = ranked.map((row) => ({ ...row, ...facts(row.name) }));
  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    if (row.url === null) continue;
    const identity = new URL(row.url).href.replace(/\/+$/, '');
    const group = groups.get(identity);
    if (group === undefined) groups.set(identity, [row]);
    else group.push(row);
  }
  const owner = new Map<string, string>();
  for (const group of groups.values()) {
    // Keep an existing registered engine as the visible identity when possible;
    // a disabled alias must not hide a usable, enabled address to the same engine.
    const score = (row: typeof rows[number]) => (occupied.includes(row.name) ? 4 : 0)
      + (row.enabled ? 2 : 0) + (row.role === 'engine' ? 1 : 0);
    let chosen = group[0];
    for (const row of group) if (score(row) > score(chosen)) chosen = row;
    for (const row of group) owner.set(row.name, chosen.name);
  }
  const roles: Record<string, EngineRole> = {};
  const visible: RankedEngineAddress[] = [];
  for (const row of rows) {
    if (owner.has(row.name) && owner.get(row.name) !== row.name) continue;
    const enabled = rows.some((other) => other.enabled && owner.get(other.name) === row.name);
    visible.push({ name: row.name, enabled: owner.has(row.name) ? enabled : row.enabled });
    // This is the role of the WORK endpoint, not of the registered front door.
    roles[row.name] = row.url === null ? row.role : 'engine';
  }
  return { ranked: visible, roles, owner };
}
