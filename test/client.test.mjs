import { readFileSync } from 'node:fs'
const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

let loaded
const React = {
  createElement: (type, props, ...kids) => ({ type, props: props ?? {}, kids }),
  useState: (init) => [init, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
}
globalThis.window = {
  __ModuleLoader__: { load: (def) => { loaded = def } },
  addEventListener() {}, removeEventListener() {},
}
globalThis.fetch = async () => ({ ok: true, json: async () => ({ enabled: true, notes: 3, intervalMs: 30000 }) })

new Function('window', 'fetch', src)(globalThis.window, globalThis.fetch)
console.log('id:', loaded.id)
const mod = loaded.factory((name) => (name === 'react' ? React : {}))
console.log('inject:', JSON.stringify(mod.inject))
const regs = []
mod.apply({ slots: { inject: (_k, cb) => cb(), register: (def, Comp) => { regs.push([def, Comp]); return () => {} } } })
console.log('slots:', JSON.stringify(regs.map(([d]) => d)))
const Comp = regs[0][1]
const tree = Comp({})
const flat = JSON.stringify(tree)
console.log('label:', flat.match(/学习模式[^"]*/)?.[0])
console.log('title:', flat.match(/"title":"[^"]+"/)?.[0])
