/**
 * Prints the argon2id hash of a master password for ADMIN_MASTER_PASSWORD_HASH.
 * The password is typed at a hidden prompt, so it never lands in shell history:
 *
 *   pnpm --filter @raffwin/api admin:master-hash
 */
import { createInterface } from 'node:readline'
import { Writable } from 'node:stream'
import { hash } from '@node-rs/argon2'

function ask(question: string): Promise<string> {
  let muted = false
  const output = new Writable({
    write(chunk, _enc, done) {
      if (!muted) process.stdout.write(chunk)
      done()
    },
  })
  const rl = createInterface({ input: process.stdin, output, terminal: true })
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close()
      process.stdout.write('\n')
      resolve(answer)
    })
    muted = true
  })
}

async function main() {
  const first = await ask('Master password (hidden): ')
  if (first.length < 16) {
    console.error('Use at least 16 characters.')
    process.exit(2)
  }
  const second = await ask('Again: ')
  if (first !== second) {
    console.error('The two entries differ.')
    process.exit(2)
  }
  console.log(`\nADMIN_MASTER_PASSWORD_HASH=${await hash(first)}\n`)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
