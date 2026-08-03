/**
 * One-shot: encrypt Gemini key1/key2 into ai_configs and set provider/model.
 * Reads keys from env (GEMINI_API_KEY1 / GEMINI_API_KEY2) or args — never logs them.
 *
 * Usage (from WhatsappBot):
 *   node --env-file=.env scripts/seed-gemini-keys.mjs
 *   # or with keys from ladies-bags-v2:
 *   node --env-file=.env --env-file=../ladies-bags-v2/.env scripts/seed-gemini-keys.mjs
 */
import { createClient } from '@supabase/supabase-js'
import { createCipheriv, randomBytes } from 'crypto'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const encKeyHex = process.env.ENCRYPTION_KEY
const key1 =
  process.env.GEMINI_API_KEY1?.trim() ||
  process.env.GEMINI_API_KEY?.trim() ||
  ''
const key2 = process.env.GEMINI_API_KEY2?.trim() || ''

if (!url || !serviceKey || !encKeyHex) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, or ENCRYPTION_KEY')
  process.exit(1)
}
if (!key1) {
  console.error('Missing GEMINI_API_KEY1 (or GEMINI_API_KEY)')
  process.exit(1)
}
if (!key2) {
  console.error('Missing GEMINI_API_KEY2')
  process.exit(1)
}

function encrypt(text) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(encKeyHex, 'hex'), iv)
  let encrypted = cipher.update(text, 'utf8', 'hex')
  encrypted += cipher.final('hex')
  const tag = cipher.getAuthTag()
  return `${iv.toString('hex')}:${encrypted}:${tag.toString('hex')}`
}

const db = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})

const { data: rows, error } = await db
  .from('ai_configs')
  .select('id, account_id, provider, model')

if (error) {
  console.error('Failed to list ai_configs:', error.message)
  process.exit(1)
}
if (!rows?.length) {
  console.error('No ai_configs rows found')
  process.exit(1)
}

const payload = {
  provider: 'gemini',
  model: 'gemini-3.5-flash-lite',
  api_key: encrypt(key1),
  gemini_api_key_2: encrypt(key2),
  is_active: true,
}

for (const row of rows) {
  const { error: upErr } = await db
    .from('ai_configs')
    .update(payload)
    .eq('id', row.id)
  if (upErr) {
    console.error(`Update failed for account ${row.account_id}:`, upErr.message)
    process.exit(1)
  }
  console.log(
    `Updated account ${row.account_id}: provider=gemini model=gemini-3.5-flash-lite key1=set key2=set`,
  )
}

console.log('Done. Keys are encrypted in DB only — remove GEMINI_* from .env when convenient.')
