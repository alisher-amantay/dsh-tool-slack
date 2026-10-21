import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { SlackClient } from '../src/client.ts'
import { createTools } from '../src/index.ts'

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 as const }]
const exec = () => ({ signal: new AbortController().signal }) as unknown as ToolRunContext

/** Real-shaped Slack payloads, including fields the plugin does not map (they must never leak into output). */
const message = {
  type: 'message', user: 'U07A71CUDQQ', text: 'hi <@U1>', ts: '1792392729.540889', team: 'T1',
  client_msg_id: 'abc', blocks: [{ type: 'rich_text', block_id: 'x', elements: [] }],
  thread_ts: '1792392729.540889', reply_count: 2, reply_users: ['U1', 'U2'], reply_users_count: 2,
  latest_reply: '1792392800.000100', is_locked: false, subscribed: true,
  reactions: [{ name: 'eyes', users: ['U1'], count: 1 }],
  edited: { user: 'U07A71CUDQQ', ts: '1792392800.000000' },
}
const botMessage = { type: 'message', subtype: 'bot_message', bot_id: 'B1', text: 'deploy', ts: '1792392000.000100', channel: 'C1' }
const user = {
  id: 'U1', team_id: 'T1', name: 'yerbol', real_name: 'Yerbol', tz: 'Asia/Almaty', tz_label: 'Alma-Ata Time', deleted: false,
  is_admin: false, is_owner: false, is_bot: false, is_restricted: false, is_ultra_restricted: false, updated: 1,
  profile: { display_name: 'Ye', real_name: 'Yerbol', email: 'y@x.io', title: 'product', image_72: 'https://i/72.png', status_text: '', status_emoji: '', avatar_hash: 'h' },
}
const channel = {
  id: 'C1', name: 'general', name_normalized: 'general', is_channel: true, is_group: false, is_im: false, is_private: false,
  is_shared: false, is_archived: false, is_member: true, is_general: true, num_members: 12, created: 1700000000,
  topic: { value: 't', creator: 'U1', last_set: 1 }, purpose: { value: 'p', creator: 'U1', last_set: 1 },
}
const file = {
  id: 'F1', name: 'a.png', title: 'a', user: 'U1', created: 1700000000, timestamp: 1700000000, updated: 1700000001,
  mimetype: 'image/png', filetype: 'png', size: 10, permalink: 'https://p', url_private: 'https://u', is_public: false, channels: ['C1'],
}
const uploadPath = join(mkdtempSync(join(tmpdir(), 'slack-up-')), 'note.txt')
writeFileSync(uploadPath, 'hello')
const meta = { response_metadata: { next_cursor: 'abc=' } }

const responses: Record<string, unknown> = {
  'auth.test': { ok: true, url: 'https://t.slack.com/', team: 'T', user: 'u', team_id: 'T1', user_id: 'U1', is_enterprise_install: false },
  'conversations.list': { ok: true, channels: [channel], ...meta },
  'conversations.info': { ok: true, channel },
  'conversations.history': { ok: true, messages: [message, botMessage], has_more: true, ...meta },
  'conversations.replies': { ok: true, messages: [message, { ...message, ts: '1792392800.000100', thread_ts: message.ts }], has_more: false },
  'conversations.members': { ok: true, members: ['U1', 'U2'], ...meta },
  'search.messages': { ok: true, messages: { matches: [{ type: 'message', channel: { id: 'C1', name: 'general' }, user: 'U1', username: 'u', text: 'x', permalink: 'https://p', ts: '1.1', team: 'T1', iid: 'i' }] } },
  'users.list': { ok: true, members: [user], ...meta },
  'users.info': { ok: true, user },
  'usergroups.list': { ok: true, usergroups: [{ id: 'S1', team_id: 'T1', is_usergroup: true, name: 'eng', handle: 'eng', description: 'd', user_count: 2, users: ['U1', 'U2'], date_create: 1 }] },
  'usergroups.users.list': { ok: true, users: ['U1', 'U2'] },
  'files.list': { ok: true, files: [file], paging: { count: 1, total: 1, page: 1, pages: 1 } },
  'chat.scheduledMessages.list': { ok: true, scheduled_messages: [{ id: 'Q1', channel_id: 'C1', post_at: 1792400000, date_created: 1792390000, text: 'later', user: 'U1' }], ...meta },
  'chat.postMessage': { ok: true, channel: 'C1', ts: '1.1', message },
  'chat.update': { ok: true, channel: 'C1', ts: '1.1', text: 'x', message },
  'chat.scheduleMessage': { ok: true, channel: 'C1', scheduled_message_id: 'Q1', post_at: 1792400000, message },
  'chat.deleteScheduledMessage': { ok: true },
  'chat.delete': { ok: true, channel: 'C1', ts: '1.1' },
  'reactions.add': { ok: true },
  'files.getUploadURLExternal': { ok: true, upload_url: 'https://files.slack.com/upload/v1/abc', file_id: 'F9' },
  'files.completeUploadExternal': { ok: true, files: [{ id: 'F9', title: 'note.txt' }] },
  'files.info': { ok: true, file: { id: 'F9', title: 'note.txt', permalink: 'https://nace.slack.com/files/U1/F9/note.txt', shares: { private: { D0123456789: [{ ts: '1792400000.000100' }] } } } },
}

/** Minimal valid args per tool; anything not listed needs none. */
const args: Record<string, Record<string, unknown>> = {
  slack_get_channel: { channel: 'C1' },
  slack_list_channel_messages: { channel: 'C1' },
  slack_list_thread_replies: { channel: 'C1', threadTs: '1792392729.540889' },
  slack_search_messages: { query: 'deploy' },
  slack_list_channel_members: { channel: 'C1' },
  slack_list_scheduled_messages: { channel: 'C1' },
  slack_list_user_group_members: { usergroup: 'S1' },
  slack_list_files: { channel: 'C1' },
  slack_get_user: { user: 'U1' },
  slack_post_message: { channel: 'C1', text: 'x' },
  slack_update_message: { channel: 'C1', ts: '1.1', text: 'x' },
  slack_schedule_message: { channel: 'C1', postAt: '1792400000', text: 'x' },
  slack_delete_scheduled_message: { channel: 'C1', scheduledMessageId: 'Q1' },
  slack_delete_message: { channel: 'C1', ts: '1.1' },
  slack_upload_file: { path: uploadPath, channel: 'D0123456789' },
  slack_add_reaction: { channel: 'C1', timestamp: '1.1', name: 'eyes' },
}

describe('output schemas accept real-shaped Slack responses', () => {
  const calls: string[] = []
  const fetchImpl = async (input: RequestInfo | URL) => {
    const method = new URL(String(input)).pathname.split('/').pop() as string
    if (String(input).startsWith('https://files.slack.com/upload')) return new Response('OK - 5', { status: 200 })
    calls.push(method)
    const body = responses[method]
    if (!body) throw new Error(`unmocked Slack method ${method}`)
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const client = new SlackClient({ lookupImpl: publicLookup, token: 't', fetchImpl: fetchImpl as typeof fetch })
  const all = createTools(client)

  it('covers every registered tool', () => {
    expect(all.length).toBe(20)
  })

  for (const tool of all) {
    it(`${tool.name}`, async () => {
      const value = await tool.execute((args[tool.name] ?? {}) as never, exec())
      const violations = validateJsonSchemaValue(tool.output.schema as never, value)
      expect(violations).toEqual([])
      expect(() => tool.output.render(args[tool.name] as never, value as never)).not.toThrow()
    })
  }

  it('list_channel_messages items carry the channel field the schema declares', async () => {
    const t = all.find(x => x.name === 'slack_list_channel_messages')!
    const value = (await t.execute({ channel: 'C1' } as never, exec())) as { items: Array<{ channel: string | null }> }
    expect(value.items.map(i => i.channel)).toEqual([null, 'C1'])
  })
})
