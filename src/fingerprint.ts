import type { MessageFingerprint } from './types';

export interface TavernMessage { is_user?: boolean; is_system?: boolean; name?: string; mes?: string; swipe_id?: number | string; swipes?: string[]; swipeId?: string }
export async function sha256(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join('');
}
export function activeSwipe(message: TavernMessage): string {
  return String(message.swipe_id ?? message.swipeId ?? (Array.isArray(message.swipes) ? message.swipes.length - 1 : '0'));
}
export async function fingerprintMessages(chat: TavernMessage[]): Promise<MessageFingerprint[]> {
  return Promise.all(chat.map(async (message, ordinal) => {
    const role = message.is_system ? 'system' : message.is_user ? 'user' : 'assistant';
    const speaker = String(message.name ?? ''); const swipeId = activeSwipe(message);
    return { fingerprint: await sha256(JSON.stringify([role, speaker, String(message.mes ?? ''), swipeId])), role, speaker, swipeId, ordinal, isAssistant: role === 'assistant' };
  }));
}
export async function chatPrefixFingerprint(messages: MessageFingerprint[], endExclusive: number) { return sha256(messages.slice(0, endExclusive).map(x => x.fingerprint).join('|')); }
