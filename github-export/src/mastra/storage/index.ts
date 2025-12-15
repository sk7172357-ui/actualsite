import { PostgresStore } from "@mastra/pg";

let _sharedPostgresStorage: PostgresStore | undefined = undefined;
let _initAttempted = false;
let _initError: Error | null = null;

export function getSharedPostgresStorage(): PostgresStore | undefined {
  if (_initAttempted) {
    return _sharedPostgresStorage;
  }
  _initAttempted = true;
  
  const dbUrl = process.env.DATABASE_URL;
  
  if (!dbUrl) {
    console.warn("[Storage] DATABASE_URL not set, storage disabled");
    return undefined;
  }
  
  // Check for known problematic hostnames in production
  if (dbUrl.includes("helium") && process.env.NODE_ENV === "production") {
    console.warn("[Storage] DATABASE_URL contains 'helium' hostname which is not accessible in production");
    return undefined;
  }
  
  try {
    _sharedPostgresStorage = new PostgresStore({
      connectionString: dbUrl,
    });
    console.log("[Storage] PostgresStore created");
    return _sharedPostgresStorage;
  } catch (error) {
    _initError = error as Error;
    console.error("[Storage] Failed to create PostgresStore:", error);
    return undefined;
  }
}

// Export a function instead of a constant to make it truly lazy
export function getStorage(): PostgresStore | undefined {
  return getSharedPostgresStorage();
}

// For backward compatibility - but initialized to undefined
export const sharedPostgresStorage = undefined as PostgresStore | undefined;
