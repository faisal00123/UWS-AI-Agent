/**
 * Routes: leads (list/detail/create/edit/stage), import (preview & commit),
 * duplicate review, audit history.
 *
 * Import accepts either:
 *   - text/csv body (raw file contents)
 *   - application/json { format: 'xlsx', filename, base64 }
 */
import { Router, text, type Request } from 'express';
import { z } from 'zod';
import { asyncRoute, type AppDeps } from '../types.ts';
import { requireAuth, requireCsrf, requireRole } from '../middleware/session.ts';
import { AppError } from '../../core/errors.ts';
import { parseCsv } from '../../domain/leads/csv.ts';
import { readExcelBuffer } from '../../domain/leads/excel.ts';
import {
  analyzeRecords,
  analyzeCsv,
  commitImport,
  summaryFromRows,
  type ImportMeta,
} from '../../domain/leads/import.ts';
import {
  LEAD_STAGES,
  changeStage,
  createLead,
  getLeadDetail,
  listLeads,
  updateLead,
} from '../../domain/leads/repository.ts';
import { listAudit } from '../../domain/audit/service.ts';
import { discoverFromWebsite } from '../../adapters/discovery/website.ts';
import { newId } from '../../core/ids.ts';
import { nowIso } from '../../core/time.ts';

const csvBody = text({ type: ['text/csv', 'text/plain', 'application/csv'], limit: '8mb' });

const listQuerySchema = z.object({
  q: z.string().max(120).optional(),
  stage: z.union([z.string(), z.array(z.string())]).optional(),
  city: z.string().max(80).optional(),
  category: z.string().max(80).optional(),
  eligibility: z.enum(['unknown', 'eligible', 'ineligible', 'needs_review']).optional(),
  minScore: z.coerce.number().min(0).max(100).optional(),
  maxScore: z.coerce.number().min(0).max(100).optional(),
  needsReview: z.coerce.boolean().optional(),
  duplicatesOnly: z.coerce.boolean().optional(),
  sort: z.enum(['score', 'discovered_at', 'name', 'stage']).optional(),
  order: z.enum(['asc', 'desc']).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(200).optional(),
  includeMerged: z.coerce.boolean().optional(),
});

const createSchema = z.object({
  displayName: z.string().min(1).max(200),
  category: z.string().max(80).nullish(),
  city: z.string().max(80).nullish(),
  websiteUrl: z.string().max(300).nullish(),
  phone: z.string().max(40).nullish(),
  email: z.string().max(254).nullish(),
  whatsapp: z.string().max(40).nullish(),
  contactPersonName: z.string().max(120).nullish(),
  sourceUrl: z.string().max(500).nullish(),
  requirements: z.string().max(2000).nullish(),
});

const updateSchema = z.object({
  updates: z
    .array(z.object({ field: z.string().min(1).max(40), value: z.union([z.string().max(2000), z.number(), z.null()]) }))
    .min(1)
    .max(30),
});

const stageSchema = z.object({
  toStage: z.string().min(1).max(40),
  reason: z.string().min(1).max(500),
  evidenceInteractionId: z.string().max(60).nullish(),
});

const xlsxSchema = z.object({
  format: z.literal('xlsx'),
  filename: z.string().max(200).optional(),
  base64: z.string().min(1),
  dryRun: z.boolean().optional(),
});

export function leadsRoutes(deps: AppDeps): Router {
  const router = Router();
  router.use(requireAuth);

  // ----------------------------------------------------------------- list --
  router.get(
    '/',
    asyncRoute((req, res) => {
      const query = listQuerySchema.parse(req.query);
      res.json(listLeads(req.ctx.deps.db, query));
    }),
  );

  router.get(
    '/stages',
    asyncRoute((_req, res) => {
      res.json({ stages: LEAD_STAGES });
    }),
  );

  // ---------------------------------------------------------------- detail --
  router.get(
    '/:id',
    asyncRoute((req, res) => {
      const id = z.string().min(1).parse(req.params.id);
      const detail = getLeadDetail(req.ctx.deps.db, id);
      const audit = listAudit(req.ctx.deps.db, { entityType: 'business', entityId: id, limit: 50 });
      res.json({ ...detail, audit: audit.rows });
    }),
  );

  // ---------------------------------------------------------------- create --
  router.post(
    '/',
    requireCsrf,
    requireRole('owner', 'staff'),
    asyncRoute((req, res) => {
      const body = createSchema.parse(req.body);
      const result = createLead(req.ctx.deps.db, body, {
        userId: req.ctx.user!.id,
        label: req.ctx.user!.role,
      });
      res.status(201).json(result);
    }),
  );

  // ---------------------------------------------------------------- update --
  router.patch(
    '/:id',
    requireCsrf,
    requireRole('owner', 'staff'),
    asyncRoute((req, res) => {
      const id = z.string().min(1).parse(req.params.id);
      const body = updateSchema.parse(req.body);
      const result = updateLead(req.ctx.deps.db, id, body.updates, {
        userId: req.ctx.user!.id,
        label: req.ctx.user!.role,
      });
      res.json(result);
    }),
  );

  router.post(
    '/:id/stage',
    requireCsrf,
    requireRole('owner', 'staff'),
    asyncRoute((req, res) => {
      const id = z.string().min(1).parse(req.params.id);
      const body = stageSchema.parse(req.body);
      const result = changeStage(req.ctx.deps.db, id, body.toStage as never, {
        reason: body.reason,
        evidenceInteractionId: body.evidenceInteractionId ?? null,
        actor: { userId: req.ctx.user!.id, label: req.ctx.user!.role },
      });
      res.json(result);
    }),
  );

  // --------------------------------------------------------------- verify --
  // Lead verification (Phase 11A, Task 6): fetch the lead's OWN public
  // homepage (an unauthenticated GET of a URL the lead itself published) and
  // record what was observed in `field_verifications` with method
  // 'http_fetch'. This is NOT outreach (no message, no call, no paid API)
  // and NOT a crawler: only the exact stored URL is fetched, once, with a
  // hard timeout + size cap. The discovery PORT is not used here because it
  // may be unconfigured — this helper is free by design.
  router.post(
    '/:id/verify',
    requireCsrf,
    requireRole('owner', 'staff'),
    asyncRoute(async (req, res) => {
      const id = z.string().min(1).parse(req.params.id);
      const detail = getLeadDetail(req.ctx.deps.db, id);
      // `business` is the raw row: columns are snake_case.
      const website = (detail.business['website_url'] as string | null) ?? null;
      if (!website) {
        throw new AppError('validation_failed', 'This lead has no website URL to verify');
      }

      const at = nowIso();
      const insertVerification = req.ctx.deps.db.prepare(
        `INSERT INTO field_verifications (id, business_id, field, value, state, method, evidence, checked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
      );

      let result: {
        ok: boolean;
        title: string | null;
        phones: string[];
        emails: string[];
        state: 'verified' | 'failed';
        checkedAt: string;
      };
      try {
        const found = await discoverFromWebsite(website);
        const state = 'verified' as const;
        insertVerification.run(
          newId('fv'),
          id,
          'website_url',
          found.finalUrl,
          state,
          'http_fetch',
          `title="${found.title ?? ''}" phones=${found.phones.length} emails=${found.emails.length}`,
          at,
        );
        result = {
          ok: true,
          title: found.title,
          phones: found.phones,
          emails: found.emails,
          state,
          checkedAt: at,
        };
      } catch (err) {
        const state = 'failed' as const;
        const message = err instanceof Error ? err.message : 'unknown error';
        insertVerification.run(newId('fv'), id, 'website_url', website, state, 'http_fetch', message.slice(0, 300), at);
        result = { ok: false, title: null, phones: [], emails: [], state, checkedAt: at };
      }

      req.ctx.deps.logger.info('lead.verified', { businessId: id, ok: result.ok });
      res.json(result);
    }),
  );

  // ---------------------------------------------------------------- import --
  router.post(
    '/import/preview',
    csvBody,
    requireCsrf,
    requireRole('owner', 'staff'),
    asyncRoute(async (req, res) => {
      const analysis = await parseImportBody(req, deps);
      res.json({ ...summaryFromRows(analysis.rows, analysis.parseErrors, false), headers: analysis.headers, unmappedHeaders: analysis.unmappedHeaders });
    }),
  );

  router.post(
    '/import',
    csvBody,
    requireCsrf,
    requireRole('owner', 'staff'),
    asyncRoute(async (req, res) => {
      const dryRun = req.query.dryRun === '1' || req.query.dryRun === 'true';
      const analysis = await parseImportBody(req, deps);
      if (dryRun) {
        res.json({ ...summaryFromRows(analysis.rows, analysis.parseErrors, false), headers: analysis.headers, unmappedHeaders: analysis.unmappedHeaders });
        return;
      }
      const meta: ImportMeta = {
        sourceType: analysis.sourceType,
        sourceLabel: analysis.sourceLabel,
        sourceUrl: null,
        importedBy: { userId: req.ctx.user!.id, label: req.ctx.user!.role },
      };
      const summary = commitImport(req.ctx.deps.db, req.ctx.deps.config, analysis, meta);
      res.json({
        totalRows: summary.totalRows,
        imported: summary.imported,
        needsReview: summary.needsReview,
        merged: summary.merged,
        rejected: summary.rejected,
        parseErrors: summary.parseErrors,
        committed: true,
        rows: summary.rows.map((r) => ({
          line: r.line,
          status: r.status,
          name: r.candidate?.displayName ?? (r.raw.name ?? ''),
          problems: r.problems,
          duplicate: r.duplicate
            ? { strategy: r.duplicate.strategy, score: r.duplicate.score, autoMerge: r.duplicate.autoMerge, businessId: r.duplicate.businessId }
            : null,
        })),
        headers: analysis.headers,
        unmappedHeaders: analysis.unmappedHeaders,
      });
    }),
  );

  return router;
}

async function parseImportBody(
  req: Request,
  deps: AppDeps,
): Promise<ReturnType<typeof analyzeRecords> & { sourceType: 'csv_import' | 'excel_import'; sourceLabel: string | null }> {
  const contentType = req.headers['content-type'] ?? '';
  const filename = String(req.headers['x-import-filename'] ?? '').slice(0, 200) || null;

  if (contentType.includes('application/json')) {
    const body = xlsxSchema.parse(req.body);
    if (body.format !== 'xlsx') {
      throw new AppError('validation_failed', 'Unsupported import format');
    }
    let buffer: Buffer;
    try {
      buffer = Buffer.from(body.base64, 'base64');
    } catch {
      throw new AppError('validation_failed', 'base64 payload could not be decoded');
    }
    if (buffer.length > 10 * 1024 * 1024) {
      throw new AppError('validation_failed', 'Workbook is larger than 10 MB');
    }
    const sheet = await readExcelBuffer(buffer);
    const analysis = analyzeRecords(deps.db, sheet.headers, sheet.records, sheet.errors);
    return { ...analysis, sourceType: 'excel_import', sourceLabel: body.filename ?? filename };
  }

  if (typeof req.body !== 'string' || req.body.trim() === '') {
    throw new AppError(
      'validation_failed',
      'Send the CSV as a raw text/csv body, or an .xlsx as JSON { format:"xlsx", base64 }',
    );
  }
  const parsed = parseCsv(req.body);
  const analysis = analyzeCsv(deps.db, parsed);
  return { ...analysis, sourceType: 'csv_import', sourceLabel: filename };
}
