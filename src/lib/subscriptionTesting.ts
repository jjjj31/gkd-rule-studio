import type { RawSubscriptionDraft } from "./testSubscription";
import type { LibrarySelection, LibraryTestSubscription, SubscriptionApp } from "../types/subscriptionLibrary";

export function buildLibraryTestSubscription(
  generated: RawSubscriptionDraft, selected: LibrarySelection | null,
): LibraryTestSubscription {
  const payload: LibraryTestSubscription = JSON.parse(JSON.stringify(generated));
  if (!selected) return payload;
  const incoming: SubscriptionApp = JSON.parse(JSON.stringify(selected.app));
  const group = incoming.groups[0];
  group.enable = true;
  const existing = payload.apps.find((app) => app.id === incoming.id);
  if (!existing) {
    payload.apps.push(incoming);
  } else {
    const keys = new Set(existing.groups.map((item) => item.key));
    if (keys.has(group.key)) {
      let next = 0;
      while (keys.has(next)) next++;
      group.key = next;
    }
    // Selection validation only permits self scopes, whose references are already local to this group.
    delete group.scopeKeys;
    existing.groups.push(group);
  }
  return payload;
}
