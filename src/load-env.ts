import { config } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Load `.env` from project root (not cwd), so `GOOGLE_CLIENT_ID` etc. apply when started from any directory. */
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
config({ path: join(root, ".env") });
