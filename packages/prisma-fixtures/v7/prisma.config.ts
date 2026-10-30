import { defineConfig } from "prisma/config";

// The schema comes from `--schema`; Prisma 7 takes the URL from here.
export default defineConfig({
  datasource: { url: process.env.DATABASE_URL ?? "" },
});
