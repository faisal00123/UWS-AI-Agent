/**
 * Demo lead seeder:
 *   - applies pending migrations (idempotent)
 *   - inserts a small set of clearly-demo Pakistani business leads
 *   - skips leads that already exist (safe to re-run)
 *
 *   cmd:  npm run seed:demo
 *
 * Demo data only: no outreach is triggered, no provider is called, and the
 * operating mode stays whatever the database already has (simulation by
 * default). Leads are created as `system` actor with no owner binding.
 */
import { loadConfig } from '../core/config.ts';
import { openDatabase } from '../db/index.ts';
import { runMigrations } from '../db/migrate.ts';
import { createLead } from '../domain/leads/repository.ts';
import type { DB } from '../db/index.ts';

interface DemoLead {
  displayName: string;
  category: string;
  city: string;
  websiteUrl: string;
  phone: string;
  requirements: string;
}

/** Names double as the idempotency key: an existing name is skipped. */
const DEMO_LEADS: DemoLead[] = [
  {
    displayName: 'Karachi Textile Traders',
    category: 'Manufacturing',
    city: 'Karachi',
    websiteUrl: 'https://karachi-textile.example.com',
    phone: '+923001112223',
    requirements: 'Demo lead — bulk fabric export website + English/Urdu product catalogue.',
  },
  {
    displayName: 'Lahore Fresh Foods',
    category: 'Retail',
    city: 'Lahore',
    websiteUrl: 'https://lahore-fresh-foods.example.com',
    phone: '+923004445556',
    requirements: 'Demo lead — grocery delivery landing page with WhatsApp ordering.',
  },
  {
    displayName: 'Islamabad Tech Solutions',
    category: 'IT Services',
    city: 'Islamabad',
    websiteUrl: 'https://islamabad-tech.example.com',
    phone: '+923007778889',
    requirements: 'Demo lead — software house portfolio site with booking form.',
  },
  {
    displayName: 'Faisalabad Fabric House',
    category: 'Manufacturing',
    city: 'Faisalabad',
    websiteUrl: 'https://faisalabad-fabric.example.com',
    phone: '+923002223334',
    requirements: 'Demo lead — wholesale denim supplier, needs SEO-ready product pages.',
  },
  {
    displayName: 'Peshawar Auto Parts',
    category: 'Automotive',
    city: 'Peshawar',
    websiteUrl: 'https://peshawar-auto-parts.example.com',
    phone: '+923005556667',
    requirements: 'Demo lead — spare parts catalogue with parts-lookup search.',
  },
];

function existingNames(db: DB): Set<string> {
  const rows = db.prepare('SELECT display_name FROM businesses').all() as { display_name: string }[];
  return new Set(rows.map((r) => r.display_name));
}

function main(): void {
  const config = loadConfig();
  const db = openDatabase(config.databasePath);

  const migrated = runMigrations(db);
  if (migrated.applied.length > 0) {
    process.stdout.write(`Applied ${migrated.applied.length} migration(s).\n`);
  }

  const present = existingNames(db);
  let created = 0;
  let skipped = 0;

  for (const lead of DEMO_LEADS) {
    if (present.has(lead.displayName)) {
      skipped += 1;
      continue;
    }
    try {
      const result = createLead(
        db,
        {
          displayName: lead.displayName,
          category: lead.category,
          city: lead.city,
          websiteUrl: lead.websiteUrl,
          phone: lead.phone,
          requirements: lead.requirements,
        },
        { userId: null, label: 'system', sourceType: 'manual' },
      );
      if (result.mergedIntoId) {
        skipped += 1;
        process.stdout.write(`merged into an existing lead: ${lead.displayName}\n`);
      } else if (result.duplicate) {
        created += 1;
        process.stdout.write(`created (flagged for duplicate review): ${lead.displayName} (${result.id})\n`);
      } else {
        created += 1;
        process.stdout.write(`created: ${lead.displayName} (${result.id})\n`);
      }
    } catch (err) {
      process.stdout.write(`failed: ${lead.displayName} - ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  const total = (db.prepare('SELECT COUNT(*) AS n FROM businesses').get() as { n: number }).n;
  process.stdout.write(`done: ${created} created, ${skipped} skipped; businesses table now has ${total} row(s).\n`);
  process.stdout.write('No outreach was triggered; operating mode is unchanged.\n');
}

main();
