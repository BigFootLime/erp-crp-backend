import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

vi.mock('../../project-office/controllers/project-office.controller', () => ({ buildAuditContext: vi.fn() }));
vi.mock('../repository/of-versioning.repository', () => ({ readMachineFamilies: vi.fn() }));
vi.mock('../services/of-versioning.service', () => ({}));
vi.mock('../services/of-document-archive', () => ({ publicOfDocumentArchiveResult: vi.fn() }));
import { capabilities } from './of-versioning.controller';

describe('generation affordance uses the existing production capability', () => {
  it.each([
    { role: 'Production', allowed: true },
    { role: 'Commercial', allowed: false },
    { role: null, allowed: false },
  ])('qualifies $role without inferring generation from client write access', async ({ role, allowed }) => {
    const json = vi.fn();
    await capabilities({ user: { role } } as unknown as Request, { json } as unknown as Response, vi.fn());
    expect(json).toHaveBeenCalledWith({ capabilities: expect.objectContaining({ generate: allowed,
      read: expect.any(Boolean), revise: expect.any(Boolean), plan_validate: expect.any(Boolean), document: expect.any(Boolean) }) });
  });
});
