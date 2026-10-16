/**
 * Creates the first admin from the server's shell (after that, super admins
 * add admins from the admin screen):
 *
 *   pnpm --filter @raffwin/api admin:create --username daniel --name "Daniel Ishaku" --telegram ada_obi --role super_admin
 *   node --env-file=.env dist/create-admin.js --username ... --name ... --telegram ... --role ...   (on the server)
 *
 * Prints a generated password ONCE; only its argon2id hash is stored. The
 * Telegram account named by --telegram is bound on the admin's first sign-in.
 */
import { parseArgs } from 'node:util'
import { appendAudit } from '../admin/audit'
import { createBody, generatePassword } from '../admin/admins'
import { hashPassword } from '../admin/session'
import { loadConfig } from '../config'
import { createDb, uniqueViolation } from '../db/client'
import { ADMIN_ROLES, adminUsers } from '../db/schema'

async function main() {
  const { values } = parseArgs({
    options: { username: { type: 'string' }, name: { type: 'string' }, telegram: { type: 'string' }, role: { type: 'string' } },
  })
  const parsed = createBody.safeParse({ username: values.username, name: values.name, telegramUsername: values.telegram, role: values.role })
  if (!parsed.success) {
    console.error(parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n'))
    console.error(`usage: admin:create --username <name> --name "<full name>" --telegram <telegram username> --role <${ADMIN_ROLES.join('|')}>`)
    process.exit(2)
  }
  const body = parsed.data
  const config = loadConfig()
  const handle = createDb(config.DATABASE_URL, { max: 1 })
  const password = generatePassword()
  try {
    await handle.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(adminUsers)
        .values({ name: body.name, username: body.username, telegramUsername: body.telegramUsername, role: body.role, passwordHash: await hashPassword(password) })
        .returning({ id: adminUsers.id })
      if (!row) throw new Error('admin insert returned no row')
      await appendAudit(tx, { adminId: null, action: 'admin.create.cli', targetType: 'admin', targetId: row.id, after: body })
    })
  } catch (error) {
    const c = uniqueViolation(error)
    if (c) {
      console.error(c === 'admin_users_username_key' ? 'That admin username is taken.' : 'That Telegram account is already an admin.')
      process.exit(1)
    }
    throw error
  } finally {
    await handle.close()
  }
  console.log(
    [
      '',
      `Admin created: ${body.name} (${body.role})`,
      `  username:           ${body.username}`,
      `  password (once):    ${password}`,
      `  Telegram account:   @${body.telegramUsername} (bound on first sign-in)`,
      '',
      `To sign in: send /${config.ADMIN_BOT_COMMAND} to the bot from @${body.telegramUsername},`,
      'then the master password, the username and the password.',
      '',
    ].join('\n'),
  )
}

main().catch((error: unknown) => {
  console.error('could not create the admin:', error)
  process.exit(1)
})
