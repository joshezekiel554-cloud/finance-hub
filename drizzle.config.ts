import "dotenv/config";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./migrations",
  dialect: "mysql",
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      "mysql://feldart_app:feldart_app@localhost:3306/feldart_finance",
  },
  strict: true,
  verbose: true,
});
