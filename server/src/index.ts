import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createApp } from './app.js';
import { db } from './db.js';
import { createAzureOpenAIInsightModelFromEnv } from './insights-model.js';

const here = dirname(fileURLToPath(import.meta.url));
// Deploy bundle copies the built client into server/public (see Bucket 6 guide).
const clientDistPath = process.env.CLIENT_DIST_PATH?.trim() || join(here, '..', 'public');

const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;
const app = createApp(db, {
  insightModel: createAzureOpenAIInsightModelFromEnv(),
  clientDistPath,
});
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
