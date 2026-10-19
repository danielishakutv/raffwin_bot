// Assembles a sales site release: api/{dist entries + the chunks they import, drizzle, package.json} and web.
// node assemble-buy.mjs <repo> <releaseRoot> <env> <sha>
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [repo, root, env, sha] = process.argv.slice(2)
const api = join(repo, 'apps/buy-api')
const out = join(root, `${env}-${sha}`)
if (existsSync(out)) throw new Error(`${out} exists; refusing to overwrite`)
mkdirSync(join(out, 'api/dist'), { recursive: true })

const seen = new Set()
const walk = (file) => {
  if (seen.has(file)) return
  seen.add(file)
  const src = readFileSync(join(api, 'dist', file), 'utf8')
  for (const m of src.matchAll(/(?:from\s*|import\s*\(?\s*)["']\.\/([^"']+\.js)["']/g)) walk(m[1])
}
;['server.js', 'migrate.js', 'reconcile.js'].forEach(walk)
for (const f of seen) cpSync(join(api, 'dist', f), join(out, 'api/dist', f))

cpSync(join(api, 'drizzle'), join(out, 'api/drizzle'), { recursive: true })
const pkg = JSON.parse(readFileSync(join(api, 'package.json'), 'utf8'))
const deps = Object.fromEntries(Object.entries(pkg.dependencies).filter(([k]) => !k.startsWith('@raffwin/')))
writeFileSync(join(out, 'api/package.json'), JSON.stringify({ name: 'buy-api-runtime', private: true, type: 'module', version: pkg.version, dependencies: deps, engines: { node: '>=20' } }, null, 2) + '\n')
cpSync(join(root, `web-${env}`), join(out, 'web'), { recursive: true })
console.log(env, 'files:', [...seen].sort().join(' '))
