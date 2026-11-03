export interface SubscriptionRule {
  key?: number;
  matches?: string | string[];
  anyMatches?: string | string[];
  preKeys?: number | number[];
  actionCdKey?: number;
  actionMaximumKey?: number;
  [field: string]: unknown;
}

export interface SubscriptionGroup {
  key: number;
  name: string;
  desc?: string;
  enable?: boolean;
  rules: SubscriptionRule[];
  [field: string]: unknown;
}

export interface SubscriptionApp {
  id: string;
  name: string;
  groups: SubscriptionGroup[];
  [field: string]: unknown;
}

export interface LibraryApp {
  id: string;
  name?: string;
  groups: unknown[];
  [field: string]: unknown;
}

export interface LibrarySource {
  url: string;
  refreshedAt: number;
  error?: string;
  subscription: {
    id: number;
    name: string;
    version: number;
    author?: string;
    apps: LibraryApp[];
    [field: string]: unknown;
  };
}

export interface LibrarySelection {
  id: string;
  sourceUrl: string;
  subscriptionId: number;
  subscriptionName: string;
  version: number;
  app: SubscriptionApp;
}

export interface LibraryImportRecord extends LibrarySelection {
  complete?: boolean;
  importedAt: number;
  deviceOrigin: string;
  /** New records store stable/beta; legacy package IDs remain historical fork records. */
  targetPackage: string;
  submittedApp: SubscriptionApp;
}

export interface LibraryTest extends LibrarySelection {
  status: "syncing" | "testing" | "ended" | "valid" | "invalid" | "failed";
  error?: string;
}

export interface LibraryTestSubscription {
  id: number;
  name: string;
  version: number;
  author: string;
  apps: SubscriptionApp[];
}
