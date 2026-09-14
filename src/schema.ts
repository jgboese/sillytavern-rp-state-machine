import { z } from 'zod';
const integer = z.number().int();
const identifier = z.string().trim().min(1).max(128);
export const localDateTime = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d$/, 'Expected YYYY-MM-DDTHH:mm').refine(value => { const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value); if (!m) return false; const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])); return d.getFullYear() === Number(m[1]) && d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]) && d.getHours() === Number(m[4]) && d.getMinutes() === Number(m[5]); }, 'Expected a real Gregorian local date/time');
const event = z.discriminatedUnion('type', [
  z.object({ type: z.literal('time.advance'), minutes: integer }),
  z.object({ type: z.literal('time.set'), localDateTime }),
  z.object({ type: z.literal('location.set'), location: identifier }),
  z.object({ type: z.literal('currency.adjust'), currency: identifier, amount: integer, name: identifier.optional() }),
  z.object({ type: z.literal('currency.set'), currency: identifier, amount: integer.min(0), name: identifier.optional() }),
  z.object({ type: z.literal('inventory.add'), item: identifier, quantity: integer.positive(), name: identifier.optional(), note: z.string().max(500).optional() }),
  z.object({ type: z.literal('inventory.remove'), item: identifier, quantity: integer.positive() }),
  z.object({ type: z.literal('inventory.set'), item: identifier, quantity: integer.min(0), name: identifier.optional(), note: z.string().max(500).optional() }),
  z.object({ type: z.literal('condition.add'), target: identifier, condition: identifier }),
  z.object({ type: z.literal('condition.remove'), target: identifier, condition: identifier }),
  z.object({ type: z.literal('relationship.adjust'), character: identifier, amount: integer.min(-5).max(5), reason: identifier }),
  z.object({ type: z.literal('relationship.note'), character: identifier, note: z.string().trim().min(1).max(500) }),
  z.object({ type: z.literal('relationship.set'), character: identifier, score: integer.min(-100).max(100), note: z.string().max(500).optional(), reason: z.string().max(500).optional() }),
  z.object({ type: z.literal('character.set'), id: identifier, displayName: identifier, aliases: z.array(identifier).max(32), conditions: z.array(identifier).max(64), relationshipScore: integer.min(-100).max(100).optional(), relationshipNote: z.string().max(500).optional() }),
]);
export const manualEventsSchema = z.array(event).min(1).max(32);
export const extractionSchema = z.object({ events: z.array(event).max(32), explanation: z.string().max(1000).default('') }).strict();
export type Extraction = z.infer<typeof extractionSchema>;
const entity = z.object({ id: identifier, name: identifier });
export const gameStateSchema = z.object({
  world: z.object({ localDateTime, location: identifier }), player: z.object({ conditions: z.array(identifier) }),
  currencies: z.record(entity.extend({ amount: integer.min(0) })),
  inventory: z.record(entity.extend({ quantity: integer.min(0), note: z.string().max(500).optional() })),
  characters: z.record(z.object({ id: identifier, displayName: identifier, aliases: z.array(identifier), conditions: z.array(identifier), relationship: z.object({ score: integer.min(-100).max(100), note: z.string().max(500).optional(), lastReason: z.string().max(500).optional() }) })),
}).strict().superRefine((state, ctx) => { for (const [key, value] of Object.entries(state.currencies)) if (key !== value.id) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Currency record key must equal id', path: ['currencies', key, 'id'] }); for (const [key, value] of Object.entries(state.inventory)) if (key !== value.id) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Inventory record key must equal id', path: ['inventory', key, 'id'] }); for (const [key, value] of Object.entries(state.characters)) if (key !== value.id) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Character record key must equal id', path: ['characters', key, 'id'] }); });
const transactionSchema = z.object({ id: identifier, origin: z.enum(['automatic', 'manual']), sourceFingerprint: z.string().optional(), sourceOrdinal: integer.nonnegative().optional(), sourceSwipeId: z.string().optional(), events: z.array(event), timestamp: z.string().datetime(), explanation: z.string().max(1000) }).strict();
export const containerSchema = z.object({
  schemaVersion: z.literal(1), status: z.enum(['ready', 'extracting', 'replaying', 'needs-reseed', 'error']),
  seed: z.object({ baseState: gameStateSchema, chatPrefixFingerprint: z.string(), messageCount: integer.nonnegative() }).strict(), currentState: gameStateSchema,
  messages: z.array(z.object({ fingerprint: z.string(), role: z.enum(['user', 'assistant', 'system']), speaker: z.string(), swipeId: z.string(), ordinal: integer.nonnegative(), isAssistant: z.boolean() }).strict()),
  transactions: z.array(transactionSchema), reviewQueue: z.array(z.object({ id: identifier, kind: z.enum(['extraction', 'semantic', 'manual', 'replay']), message: z.string(), raw: z.string().optional(), transaction: transactionSchema.optional(), sourceFingerprint: z.string().optional(), createdAt: z.string().datetime() }).strict()),
}).strict();
export const EXTRACTION_JSON_SCHEMA = {
  name: 'rp_state_events', description: 'Explicit durable RP state changes only.', strict: true, value: { type: 'object', additionalProperties: false, required: ['events', 'explanation'],
  properties: { events: { type: 'array', maxItems: 32, items: { oneOf: [
    { type: 'object', additionalProperties: false, required: ['type', 'minutes'], properties: { type: { const: 'time.advance' }, minutes: { type: 'integer' } } },
    { type: 'object', additionalProperties: false, required: ['type', 'localDateTime'], properties: { type: { const: 'time.set' }, localDateTime: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}$' } } },
    { type: 'object', additionalProperties: false, required: ['type', 'location'], properties: { type: { const: 'location.set' }, location: { type: 'string' } } },
    { type: 'object', additionalProperties: false, required: ['type', 'currency', 'amount'], properties: { type: { const: 'currency.adjust' }, currency: { type: 'string' }, amount: { type: 'integer' } } },
    { type: 'object', additionalProperties: false, required: ['type', 'item', 'quantity'], properties: { type: { enum: ['inventory.add', 'inventory.remove'] }, item: { type: 'string' }, quantity: { type: 'integer' } } },
    { type: 'object', additionalProperties: false, required: ['type', 'target', 'condition'], properties: { type: { enum: ['condition.add', 'condition.remove'] }, target: { type: 'string' }, condition: { type: 'string' } } },
    { type: 'object', additionalProperties: false, required: ['type', 'character', 'amount', 'reason'], properties: { type: { const: 'relationship.adjust' }, character: { type: 'string' }, amount: { type: 'integer', minimum: -5, maximum: 5 }, reason: { type: 'string' } } },
    { type: 'object', additionalProperties: false, required: ['type', 'character', 'note'], properties: { type: { const: 'relationship.note' }, character: { type: 'string' }, note: { type: 'string' } } }
  ] } }, explanation: { type: 'string' } }
  }
} as const;
