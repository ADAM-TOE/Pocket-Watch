import { fileURLToPath } from 'node:url';
import { db } from './db.js';
import { seedReferenceData } from './seed.js';
import { createAccount } from './accounts.js';

// Operator-only account creation. There is no public signup route; you run this
// on the server to add a person:
//
//   npm run create-user -- someone@example.com "a long passphrase"
//
// It ensures the shared reference data exists, creates the account with its
// seeded cards + budget, and prints the one-time recovery codes ONCE. Copy them
// somewhere safe — they are stored only as hashes and cannot be shown again.
async function main(): Promise<void> {
  const email = process.argv[2];
  const password = process.argv[3];
  if (!email || !password) {
    console.error('Usage: npm run create-user -- <email> <password>');
    process.exit(1);
  }

  seedReferenceData(db);

  try {
    const { userId, recoveryCodes } = await createAccount(db, email, password);
    console.log(`\nCreated user #${userId} <${email.trim().toLowerCase()}>`);
    console.log('\nRecovery codes (shown ONCE — store these offline):');
    for (const code of recoveryCodes) console.log(`  ${code}`);
    console.log('');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Could not create account: ${message}`);
    process.exit(1);
  }
}

// Only run when invoked directly (npm run create-user), not when imported.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
