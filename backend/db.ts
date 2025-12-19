import { default as Surreal } from "surrealdb";

let db: Surreal | null = null;
let isConnecting = false;

export const getDB = async (): Promise<Surreal> => {
  if (db) {
    return db;
  }

  if (isConnecting) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    return getDB();
  }

  isConnecting = true;

  try {
    const newDb = new Surreal();
    
    await newDb.connect(process.env.EXPO_PUBLIC_RORK_DB_ENDPOINT!, {
      namespace: process.env.EXPO_PUBLIC_RORK_DB_NAMESPACE!,
      database: "trading_signals",
    });
    
    await newDb.authenticate(process.env.EXPO_PUBLIC_RORK_DB_TOKEN!);
    
    console.log("✅ Database connected successfully");
    db = newDb;
    isConnecting = false;
    return db;
  } catch (error) {
    isConnecting = false;
    console.error("❌ Database connection error:", error);
    throw new Error("Failed to connect to database");
  }
};
