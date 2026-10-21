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
const dir = mkdtempSync(join(tmpdir(), 'slack-upload-'))
const file = join(dir, 'report.txt')
writeFileSync(file, 'hello slack')

interface Call { url: string; method: string; headers: Record<string, string>; body: unknown }

function setup(overrides: Record<string, unknown> = {}, maxUploadBytes?: number) {
  const calls: Call[] = []
  const responses: Record<string, unknown> = {
    'files.getUploadURLExternal': { ok: true, upload_url: 'https://files.slack.com/upload/v1/abc', file_id: 'F1' },
    'files.completeUploadExternal': { ok: true, files: [{ id: 'F1', title: 'report.txt' }] },
    'files.info': { ok: true, file: { id: 'F1', permalink: 'https://nace.slack.com/files/U1/F1/report.txt', shares: { private: { D0123456789: [{ ts: '1792400000.000100' }] } } } },
    ...overrides,
  }
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, method: init?.method ?? 'GET', headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body })
    if (url.startsWith('https://files.slack.com/upload')) return new Response('OK - 11', { status: 200 })
    const method = new URL(url).pathname.split('/').pop() as string
    return new Response(JSON.stringify(responses[method] ?? { ok: false, error: 'unmocked' }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const client = new SlackClient({ lookupImpl: publicLookup, token: 'xoxp-t', fetchImpl: fetchImpl as typeof fetch, maxUploadBytes })
  const tool = createTools(client).find(t => t.name === 'slack_upload_file')!
  return { calls, tool }
}

describe('slack_upload_file', () => {
  it('runs getUploadURLExternal -> byte upload -> completeUploadExternal and returns file id, permalink and ts', async () => {
    const { calls, tool } = setup()
    const result = await tool.execute({ path: file, channel: 'D0123456789', title: 'Weekly', initialComment: 'see attached', threadTs: '1.1' } as never, exec())

    expect(calls.map(c => new URL(c.url).pathname.split('/').pop())).toEqual(['files.getUploadURLExternal', 'abc', 'files.completeUploadExternal', 'files.info'])
    const [reserve, upload, complete] = calls
    expect(reserve.method).toBe('POST')
    const q = new URL(reserve.url).searchParams
    expect(q.get('filename')).toBe('report.txt')
    expect(q.get('length')).toBe('11')
    expect(upload.url).toBe('https://files.slack.com/upload/v1/abc')
    expect(Buffer.from(upload.body as Uint8Array).toString()).toBe('hello slack')
    expect(JSON.stringify(upload.headers).toLowerCase()).not.toContain('authorization')
    const form = new URLSearchParams(String(complete.body))
    expect(form.get('channel_id')).toBe('D0123456789')
    expect(form.get('thread_ts')).toBe('1.1')
    expect(form.get('initial_comment')).toBe('see attached')
    expect(JSON.parse(form.get('files')!)).toEqual([{ id: 'F1', title: 'Weekly' }])

    expect(result).toMatchObject({ ok: true, fileId: 'F1', permalink: 'https://nace.slack.com/files/U1/F1/report.txt', ts: '1792400000.000100', channel: 'D0123456789', size: 11 })
    expect(validateJsonSchemaValue(tool.output.schema as never, result)).toEqual([])
  })

  it('still succeeds, with null permalink/ts, when files.info lacks files:read', async () => {
    const { tool } = setup({ 'files.info': { ok: false, error: 'missing_scope' } })
    const result = await tool.execute({ path: file, channel: 'D0123456789' } as never, exec())
    expect(result).toMatchObject({ ok: true, fileId: 'F1', permalink: null, ts: null })
    expect(validateJsonSchemaValue(tool.output.schema as never, result)).toEqual([])
  })

  it('resolves a channel name to an id before completing', async () => {
    const { calls, tool } = setup({ 'conversations.list': { ok: true, channels: [{ id: 'C42', name: 'general' }] } })
    await tool.execute({ path: file, channel: '#general' } as never, exec())
    const complete = calls.find(c => c.url.includes('completeUploadExternal'))!
    expect(new URLSearchParams(String(complete.body)).get('channel_id')).toBe('C42')
  })

  it('reports a missing file without calling Slack', async () => {
    const { calls, tool } = setup()
    const result = await tool.execute({ path: join(dir, 'nope.txt'), channel: 'D0123456789' } as never, exec())
    expect(result).toMatchObject({ ok: false })
    expect((result as { reason: string }).reason).toContain('File not found')
    expect(calls).toHaveLength(0)
    expect(validateJsonSchemaValue(tool.output.schema as never, result)).toEqual([])
  })

  it('reports a too-large file without calling Slack', async () => {
    const { calls, tool } = setup({}, 5)
    const result = await tool.execute({ path: file, channel: 'D0123456789' } as never, exec())
    expect(result).toMatchObject({ ok: false })
    expect((result as { reason: string }).reason).toContain('too large')
    expect(calls).toHaveLength(0)
  })

  it('reports a directory as not a regular file', async () => {
    const { tool } = setup()
    const result = await tool.execute({ path: dir, channel: 'D0123456789' } as never, exec())
    expect((result as { reason: string }).reason).toContain('Not a regular file')
  })

  it('surfaces missing_scope clearly', async () => {
    const { tool } = setup({ 'files.getUploadURLExternal': { ok: false, error: 'missing_scope' } })
    const result = await tool.execute({ path: file, channel: 'D0123456789' } as never, exec())
    expect(result).toMatchObject({ ok: false })
    expect((result as { reason: string }).reason).toMatch(/missing_scope.*files:write/)
    expect(validateJsonSchemaValue(tool.output.schema as never, result)).toEqual([])
  })

  it('fails when the byte upload is rejected', async () => {
    const calls: string[] = []
    const fetchImpl = async (input: RequestInfo | URL) => {
      const url = String(input)
      calls.push(url)
      if (url.startsWith('https://files.slack.com/')) return new Response('nope', { status: 500 })
      return new Response(JSON.stringify({ ok: true, upload_url: 'https://files.slack.com/upload/v1/x', file_id: 'F1' }), { status: 200 })
    }
    const tool = createTools(new SlackClient({ lookupImpl: publicLookup, token: 't', fetchImpl: fetchImpl as typeof fetch })).find(t => t.name === 'slack_upload_file')!
    const result = await tool.execute({ path: file, channel: 'D0123456789' } as never, exec())
    expect(result).toMatchObject({ ok: false })
    expect(calls.some(u => u.includes('completeUploadExternal'))).toBe(false)
  })

  it('is described as a WRITE operation', () => {
    expect(setup().tool.description).toContain('WRITE operation')
  })
})
