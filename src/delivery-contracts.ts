import { z } from 'zod';
import { digest, idSchema } from './contracts.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const projectRequestSchema = z.object({
  key: hash, payloadHash: hash, tenantId: idSchema, projectId: idSchema,
  scope: z.string().min(20).max(4000),
}).strict();
export const receiptSchema = z.object({
  key: hash, payloadHash: hash, externalId: z.string().min(1).max(200),
}).strict();
export type ProjectRequest = z.infer<typeof projectRequestSchema>;
export type Receipt = z.infer<typeof receiptSchema>;
export interface ProjectDestination { createProject(request: ProjectRequest): Promise<unknown> }
export type ProjectDelivery = {
  key: string; payloadHash: string; status: 'pending' | 'delivered'; receipt?: Receipt;
};
// One creation per tenant/project. A new scope requires a separate future update operation.
export function projectKey(tenantId: string, projectId: string) {
  return digest(['create-project:v1', tenantId, projectId]);
}
