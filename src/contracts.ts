import { createHash } from 'node:crypto';
import { z } from 'zod';

export const idSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
export const principalSchema = z.object({
  tenantId: idSchema, userId: idSchema, canApprove: z.boolean(),
}).strict();
export type Principal = z.infer<typeof principalSchema>;
export const intakeSchema = z.object({
  projectId: idSchema, brief: z.string().trim().min(20).max(20_000),
}).strict();
export const taskSchema = z.object({
  role: z.enum(['research', 'design', 'tech-lead', 'engineering', 'backend', 'qa']),
  objective: z.string().trim().min(10).max(1000),
  acceptance: z.array(z.string().trim().min(5).max(500)).min(1).max(8),
}).strict();
export const planSchema = z.object({
  scope: z.string().trim().min(20).max(4000),
  unknowns: z.array(z.string().trim().min(5).max(500)).max(12),
  tasks: z.array(taskSchema).min(1).max(8),
}).strict();
export type Plan = z.infer<typeof planSchema>;
export const decisionSchema = z.object({ approved: z.boolean(), planHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const envelopeSchema = intakeSchema.extend({ tenantId: idSchema, runId: z.uuid() });
export type Envelope = z.infer<typeof envelopeSchema>;
export type Planner = (input: Envelope) => Promise<unknown>;
export function digest(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
export function memoryIds(input: Envelope) {
  return { resource: digest([input.tenantId, input.projectId]), thread: digest([input.tenantId, input.projectId, input.runId]) };
}
