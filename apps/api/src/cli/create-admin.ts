/**
 * Creates an admin account from the server's shell (there is no sign-up page):
 *
 *   pnpm --filter @raffwin/api admin:create --email ada@example.com --name "Ada Obi" --role super_admin
 *   node dist/create-admin.js --email ... --name ... --role ...      (built, on the server)
 *
 * Prints a generated password and the authenticator secret ONCE. Only the
 * argon2id hash and the encrypted secret are stored. Hand them to the admin
 * over a channel you trust, then ask them to sign in and confirm.
 */
import { randomBytes } from 'node:crypto'
import { parseArgs } from 'node:util'
import { loadConfig } from '../config'
import { appendAudit } from '../admin/audit'
import { hashPassword } from '../admin/session'
import { createDb, uniqueViolation } from '../db/client'
import { ADMIN_ROLES, adminUsers, type AdminRole } from '../db/schema'
import { encrypt, newTotpSecret, otpauthUri, parseDataKey } from '../lib/admin-crypto'

async function main() {
  const { values } = parseArgs({
    options: { email: { type: 'string' }, name: { type: 'string' }, role: { type: 'string' } },
  })
  const email = values.email?.trim().toLowerCase()
  const name = values.name?.trim()
  const role = values.role as AdminRole | undefined
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || !name || !role || !ADMIN_ROLES.includes(role)) {
    console.error(`usage: admin:create --email <email> --name "<full name>" --role <${ADMIN_ROLES.join('|')}>`)
    process.exit(2)
  }

  const config = loadConfig()
  const handle = createDb(config.DATABASE_URL, { max: 1 })
  const password = randomBytes(18).toString('base64url')
  const secret = newTotpSecret()
  try {
    await handle.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(adminUsers)
        .values({
          email,
          name,
          role,
          passwordHash: await hashPassword(password),
          totpSecretEnc: encrypt(secret, parseDataKey(config.ADMIN_DATA_KEY)),
        })
        .returning({ id: adminUsers.id })
      if (!row) throw new Error('admin insert returned no row')
      await appendAudit(tx, { adminId: null, action: 'admin.create.cli', targetType: 'admin', targetId: row.id, after: { email, name, role } })
    })
  } catch (error) {
    if (uniqueViolation(error) === 'admin_users_email_key') {
      console.error(`An admin with email ${email} already exists.`)
      process.exit(1)
    }
    throw error
  } finally {
    await handle.close()
  }

  console.log(
    [
      '',
      `Admin created: ${name} <${email}> as ${role}`,
      '',
      `Password (shown once):        ${password}`,
      `Authenticator secret (once):  ${secret}`,
      `Authenticator URI:            ${otpauthUri(secret, email)}`,
      '',
      'Add the secret to Google Authenticator, Authy or 1Password (manual entry, time-based),',
      `and add ${email} to the Cloudflare Access policy for the admin site.`,
      '',
    ].join('\n'),
  )
}

main().catch((error: unknown) => {
  console.error('could not create the admin:', error)
  process.exit(1)
})
