import pool from '../../../config/database';
import type { PoolClient } from 'pg';
import type { CumpCoverageSnapshot } from '../domain/cump-coverage';
import { CUMP_ARTICLE_COVERAGE_SQL } from './cump-coverage.sql';

export async function readCumpArticleCoverage(articleId:string,db:Pick<PoolClient,'query'>=pool):Promise<CumpCoverageSnapshot|null> {
  return (await db.query<CumpCoverageSnapshot>(CUMP_ARTICLE_COVERAGE_SQL,[articleId])).rows[0]??null;
}
