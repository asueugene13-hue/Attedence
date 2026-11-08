import type { AuditEntry } from '../modules/audit-logs/audit.service.js';
import type { AccessClaims } from '../modules/auth/token.service.js';
import type { RequestContext } from './request-context.js';

/** JSON-safe copy (dates become ISO strings, Decimals become strings) for audit before/after values. */
const plain = (value: object) => JSON.parse(JSON.stringify(value)) as object;

/** Builds an audit entry for a change made by a signed-in person. */
export function auditEntry(
  actor: AccessClaims,
  action: string,
  entity: { type: string; id: string },
  change: { before?: object | null; after?: object | null; reason?: string },
  context: RequestContext,
): AuditEntry {
  return {
    action,
    entityType: entity.type,
    entityId: entity.id,
    actorUserId: actor.userId,
    actorRoleKey: actor.role,
    before: change.before ? (plain(change.before) as AuditEntry['before']) : undefined,
    after: change.after ? (plain(change.after) as AuditEntry['after']) : undefined,
    reason: change.reason,
    context,
  };
}
